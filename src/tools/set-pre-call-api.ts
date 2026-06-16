import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";
import { persistAgentConfig, VERSIONED_DRAFT_HINT } from "./agent-tools-helper.js";

export function registerSetPreCallApi(server: McpServer) {
  server.registerTool(
    "set_pre_call_api",
    {
      description:
        "Configure (or disable) an agent's pre-call API. This is an HTTP request the platform makes automatically BEFORE the call connects — typically to enrich the agent with data, e.g. look up a customer record by phone number. " +
        "Values extracted via response_variables become {{variables}} you can reference in the prompt and first message. " +
        "This is different from add_agent_tool: a pre-call API always runs once before the call and is not chosen by the LLM, whereas an api_call tool is invoked by the agent during the conversation. " +
        "There is exactly one pre-call API per agent (this replaces it). For versioned agents the change is saved as a draft — pass `draft_id` to stack onto an existing draft, then publish_draft to make it live.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to configure"),
        draft_id: z
          .string()
          .optional()
          .describe(
            "Existing draft to write into (stacks this change onto the draft's other edits). Omit to create a new draft from the live version."
          ),
        enabled: z
          .boolean()
          .optional()
          .describe("Enable the pre-call API (default true). Pass false to disable it while keeping the saved config."),
        url: z
          .string()
          .url()
          .optional()
          .describe("Endpoint URL. Required when enabling. May contain {{variable}} placeholders (e.g. system variables like {{from_number}})."),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe("HTTP method. Default GET."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Request headers as key/value pairs. Values may contain {{variable}} placeholders."),
        body: z
          .record(z.string(), z.any())
          .optional()
          .describe("Request body as a JSON object (for POST/PUT/PATCH). Values may contain {{variable}} placeholders."),
        query_params: z
          .record(z.string(), z.string())
          .optional()
          .describe("URL query parameters as key/value pairs. Values may contain {{variable}} placeholders."),
        timeout_secs: z
          .number()
          .min(1)
          .max(30)
          .optional()
          .describe("Request timeout in seconds (1-30). Default 5. Note: seconds, not milliseconds."),
        response_variables: z
          .array(
            z.object({
              variableName: z.string().min(1).describe("Variable name the agent can reference as {{variableName}}"),
              jsonPath: z.string().min(1).describe("JSON path into the response, e.g. data.customer.name"),
            })
          )
          .optional()
          .describe("Extract values from the API response into variables usable in the prompt and first message."),
      },
    },
    async (params) => {
      const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);
      if (!agentResult.ok) {
        if (agentResult.status === 404) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(agentResult) }] };
      }

      const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO;
      if (agent.workflowType === "workflow_graph") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Smallest MCP does not support conversation flow (workflow_graph) agents. The pre-call API can only be set on single_prompt agents.",
            },
          ],
        };
      }

      const current = agent.preCallAPI;
      const enabling = params.enabled !== false;

      const url = params.url ?? current?.url;
      if (enabling && (!url || url.trim().length === 0)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "A 'url' is required to enable the pre-call API (none provided and none currently configured).",
            },
          ],
        };
      }

      // Build the preCallAPI object, preserving existing fields when not overridden.
      const preCallAPI: Record<string, unknown> = {
        isEnabled: enabling,
        url: url ?? "",
        method: params.method ?? current?.method ?? "GET",
        timeout: params.timeout_secs ?? current?.timeout ?? 5,
        responseVariables: params.response_variables ?? current?.responseVariables ?? [],
      };
      const headers = params.headers ?? current?.headers;
      if (headers !== undefined) preCallAPI.headers = headers;
      const body = params.body ?? current?.body;
      if (body !== undefined) preCallAPI.body = body;
      const queryParams = params.query_params ?? current?.queryParams;
      if (queryParams !== undefined) preCallAPI.queryParams = queryParams;

      const persisted = await persistAgentConfig(agent, { preCallAPI }, params.draft_id);
      if (!persisted.ok) {
        return { content: [{ type: "text" as const, text: persisted.message }] };
      }

      const result: Record<string, unknown> = {
        message: enabling
          ? `Pre-call API ${current?.isEnabled ? "updated" : "enabled"} (${preCallAPI.method} ${preCallAPI.url}).`
          : "Pre-call API disabled.",
        agentId: params.agent_id,
        preCallAPI: {
          isEnabled: enabling,
          method: preCallAPI.method,
          url: preCallAPI.url,
          extractsVariables: (preCallAPI.responseVariables as unknown[]).length,
        },
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
