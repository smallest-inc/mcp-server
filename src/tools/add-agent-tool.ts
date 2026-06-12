import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchAgentAndTools, persistAgentTools, VERSIONED_DRAFT_HINT } from "./agent-tools-helper.js";

export function registerAddAgentTool(server: McpServer) {
  server.registerTool(
    "add_agent_tool",
    {
      description:
        "Add (or update) an API-call tool on a single_prompt agent. API-call tools let the agent make an HTTP request to an external API during a call — e.g. look up an order, book an appointment, or post to a CRM. " +
        "The agent decides when to invoke the tool based on its name and description, filling in any declared parameters. " +
        "Upserts by name: if a tool with the same name already exists it is replaced; otherwise it is added (existing tools are preserved). " +
        "For versioned agents the change is saved as a draft — use publish_draft to make it live. Use get_agent_prompt to see an agent's current tools.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to add the tool to"),
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
          .describe(
            "Extract values from the API response into variables the agent can use later in the conversation."
          ),
        enabled: z.boolean().optional().describe("Whether the tool is active (default true)"),
      },
    },
    async (params) => {
      // Reject enum parameters without values up front (matches backend rule).
      const badEnum = (params.parameters ?? []).find(
        (p) => p.type === "enum" && (!p.values || p.values.filter((v) => v.trim()).length === 0)
      );
      if (badEnum) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Parameter '${badEnum.name}' is type 'enum' but has no allowed values. Provide a non-empty 'values' array.`,
            },
          ],
        };
      }

      const fetched = await fetchAgentAndTools(params.agent_id);
      if (!fetched.ok) {
        return { content: [{ type: "text" as const, text: fetched.message }] };
      }

      // Build the api_call tool in the backend's expected shape.
      const tool: Record<string, unknown> = {
        type: "api_call",
        name: params.name,
        description: params.description,
        enabled: params.enabled ?? true,
        url: params.url,
        method: params.method,
        timeout: params.timeout_ms ?? 5000,
        headers: params.headers ?? {},
        responseVariables: params.response_variables ?? [],
      };
      if (params.parameters !== undefined) {
        tool.llmParameters = params.parameters.map((p) => ({
          name: p.name,
          description: p.description,
          type: p.type,
          required: p.required ?? false,
          ...(p.values !== undefined && { values: p.values }),
        }));
      }
      if (params.query_params !== undefined) tool.queryParams = params.query_params;
      if (params.request_body !== undefined) tool.requestBody = params.request_body;

      // Upsert by name (case-sensitive, matching exact tool name).
      const existing = fetched.tools.filter((t) => t?.name !== params.name);
      const replaced = existing.length !== fetched.tools.length;
      const tools = [...existing, tool];

      const persisted = await persistAgentTools(fetched.agent, fetched.prompt, tools);
      if (!persisted.ok) {
        return { content: [{ type: "text" as const, text: persisted.message }] };
      }

      const result: Record<string, unknown> = {
        message: `API-call tool '${params.name}' ${replaced ? "updated" : "added"} (${tools.length} tool${tools.length === 1 ? "" : "s"} total).`,
        agentId: params.agent_id,
        tool: { name: params.name, method: params.method, url: params.url },
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
