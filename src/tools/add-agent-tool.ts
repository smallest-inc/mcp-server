import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchAgentAndTools, persistAgentTools, VERSIONED_DRAFT_HINT } from "./agent-tools-helper.js";

/** Schema for one API-call tool — used both for the single-tool params and the batch `tools` array.
 *  Exported for reuse by the Playbooks tools (playbook tools use the same function shape). */
export const apiToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[^\s]+$/, "Tool name cannot contain spaces (use snake_case, e.g. lookup_order)")
    .describe("Unique tool name, no spaces (e.g. lookup_order). Re-using a name replaces that tool."),
  description: z
    .string()
    .min(1)
    .describe(
      "What the tool does and when the agent should call it. This is the only guidance the LLM gets — be specific."
    ),
  url: z.string().url().describe("The endpoint URL to call. May contain {{variable}} placeholders."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
  timeout_ms: z
    .number()
    .min(1000)
    .max(30000)
    .optional()
    .describe("Request timeout in milliseconds (1000-30000). Default 5000."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Static request headers as key/value pairs, e.g. { 'X-Api-Key': 'abc' }."),
  query_params: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe("Static query-string parameters. Values may contain {{variable}} placeholders."),
  request_body: z
    .string()
    .optional()
    .describe(
      "Request body as a JSON string (for POST/PUT/PATCH). Must be valid JSON. May contain {{variable}} or {{parameter}} placeholders."
    ),
  parameters: z
    .array(
      z.object({
        name: z.string().min(1).describe("Parameter name (referenced in url/body as {{name}})"),
        description: z.string().min(1).describe("What this parameter is — guides the LLM on what to extract"),
        type: z
          .enum(["text", "number", "boolean", "enum"])
          .describe("Parameter type. Use 'enum' for a fixed set of allowed values."),
        required: z.boolean().optional().describe("Whether the LLM must supply this parameter (default false)"),
        values: z
          .array(z.string())
          .optional()
          .describe("Allowed values — required when type is 'enum'."),
      })
    )
    .optional()
    .describe(
      "Parameters the LLM fills in at call time (mapped to llmParameters). Reference them in url/query/body as {{name}}."
    ),
  response_variables: z
    .array(
      z.object({
        variableName: z.string().min(1).describe("Variable to store the extracted value in"),
        jsonPath: z.string().min(1).describe("JSON path into the response, e.g. data.order.status"),
      })
    )
    .optional()
    .describe("Extract values from the API response into variables the agent can use later in the conversation."),
  enabled: z.boolean().optional().describe("Whether the tool is active (default true)"),
});

export type ApiToolInput = z.infer<typeof apiToolSchema>;

/** Map a tool input to the backend's expected api_call shape. */
export function buildApiCallTool(t: ApiToolInput): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "api_call",
    name: t.name,
    description: t.description,
    enabled: t.enabled ?? true,
    url: t.url,
    method: t.method,
    timeout: t.timeout_ms ?? 5000,
    headers: t.headers ?? {},
    responseVariables: t.response_variables ?? [],
  };
  if (t.parameters !== undefined) {
    tool.llmParameters = t.parameters.map((p) => ({
      name: p.name,
      description: p.description,
      type: p.type,
      required: p.required ?? false,
      ...(p.values !== undefined && { values: p.values }),
    }));
  }
  if (t.query_params !== undefined) tool.queryParams = t.query_params;
  if (t.request_body !== undefined) tool.requestBody = t.request_body;
  return tool;
}

/** Reject enum parameters without values up front (matches backend rule). */
function findBadEnumParam(tools: ApiToolInput[]): { tool: string; param: string } | null {
  for (const t of tools) {
    const bad = (t.parameters ?? []).find(
      (p) => p.type === "enum" && (!p.values || p.values.filter((v) => v.trim()).length === 0)
    );
    if (bad) return { tool: t.name, param: bad.name };
  }
  return null;
}

export function registerAddAgentTool(server: McpServer) {
  server.registerTool(
    "add_agent_tool",
    {
      description:
        "Add (or update) one or more API-call tools on a single_prompt agent. API-call tools let the agent make an HTTP request to an external API during a call — e.g. look up an order, book an appointment, or post to a CRM. " +
        "The agent decides when to invoke a tool based on its name and description, filling in any declared parameters. " +
        "Pass a single tool via the top-level fields, or several at once via `tools` (preferred when configuring multiple tools — they land in one draft write). " +
        "Upserts by name: tools with existing names are replaced; others are added (existing tools are preserved). " +
        "For versioned agents the change is saved as a draft — pass `draft_id` to stack onto an existing draft (e.g. one returned by update_agent_prompt or set_pre_call_api) instead of creating a new one, then publish_draft once. " +
        "Caveat: the draft's tools section is written wholesale, so when targeting a draft that already had tool edits, include ALL desired tools in this call. Use get_agent_prompt to see an agent's current live tools.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to add the tool(s) to"),
        draft_id: z
          .string()
          .optional()
          .describe(
            "Existing draft to write into (stacks this change onto the draft's other edits). Omit to create a new draft from the live version."
          ),
        tools: z
          .array(apiToolSchema)
          .optional()
          .describe(
            "Batch mode: multiple API-call tools to add/update in one write. When provided, the top-level single-tool fields are ignored."
          ),
        name: apiToolSchema.shape.name.optional(),
        description: apiToolSchema.shape.description.optional(),
        url: apiToolSchema.shape.url.optional(),
        method: apiToolSchema.shape.method.optional(),
        timeout_ms: apiToolSchema.shape.timeout_ms,
        headers: apiToolSchema.shape.headers,
        query_params: apiToolSchema.shape.query_params,
        request_body: apiToolSchema.shape.request_body,
        parameters: apiToolSchema.shape.parameters,
        response_variables: apiToolSchema.shape.response_variables,
        enabled: apiToolSchema.shape.enabled,
      },
    },
    async (params) => {
      // Collect the tool inputs: batch `tools` array, or the single top-level tool.
      let inputs: ApiToolInput[];
      if (params.tools && params.tools.length > 0) {
        inputs = params.tools;
      } else {
        if (!params.name || !params.description || !params.url || !params.method) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Provide either a `tools` array, or all of `name`, `description`, `url` and `method` for a single tool.",
              },
            ],
          };
        }
        inputs = [
          {
            name: params.name,
            description: params.description,
            url: params.url,
            method: params.method,
            timeout_ms: params.timeout_ms,
            headers: params.headers,
            query_params: params.query_params,
            request_body: params.request_body,
            parameters: params.parameters,
            response_variables: params.response_variables,
            enabled: params.enabled,
          },
        ];
      }

      // Reject duplicate names within the batch.
      const seen = new Set<string>();
      for (const t of inputs) {
        if (seen.has(t.name)) {
          return {
            content: [
              { type: "text" as const, text: `Duplicate tool name '${t.name}' in the tools array.` },
            ],
          };
        }
        seen.add(t.name);
      }

      const badEnum = findBadEnumParam(inputs);
      if (badEnum) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool '${badEnum.tool}' parameter '${badEnum.param}' is type 'enum' but has no allowed values. Provide a non-empty 'values' array.`,
            },
          ],
        };
      }

      const fetched = await fetchAgentAndTools(params.agent_id);
      if (!fetched.ok) {
        return { content: [{ type: "text" as const, text: fetched.message }] };
      }

      // Upsert by name (case-sensitive): keep tools not being replaced, append the new ones.
      const newNames = new Set(inputs.map((t) => t.name));
      const kept = fetched.tools.filter((t) => !newNames.has(t?.name));
      const replacedCount = fetched.tools.length - kept.length;
      const tools = [...kept, ...inputs.map(buildApiCallTool)];

      const persisted = await persistAgentTools(fetched.agent, fetched.prompt, tools, params.draft_id);
      if (!persisted.ok) {
        return { content: [{ type: "text" as const, text: persisted.message }] };
      }

      const result: Record<string, unknown> = {
        message:
          inputs.length === 1
            ? `API-call tool '${inputs[0].name}' ${replacedCount > 0 ? "updated" : "added"} (${tools.length} tool${tools.length === 1 ? "" : "s"} total).`
            : `${inputs.length} API-call tools written (${replacedCount} replaced, ${tools.length} tools total).`,
        agentId: params.agent_id,
        tools: inputs.map((t) => ({ name: t.name, method: t.method, url: t.url })),
        totalTools: tools.length,
      };
      if (persisted.versioned) {
        result.versioned = true;
        result.draftId = persisted.draftId;
        result.status = "draft";
        result.hint = VERSIONED_DRAFT_HINT;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
