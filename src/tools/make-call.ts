import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerMakeCall(server: McpServer) {
  server.registerTool(
    "make_call",
    {
      description:
        "Initiate an outbound phone call using a specific agent. The agent will call the provided phone number and follow its configured prompt. Only telephony outbound calls are supported — for webcall or chat, use app.smallest.ai.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to use for the call"),
        phone_number: z.string().describe("Phone number to call in E.164 format (e.g. +14155551234)"),
        from_product_id: z
          .string()
          .optional()
          .describe(
            "Telephony product ID to use as the caller ID. Must be a phone number product owned by your org. If omitted, a default number is used. Use get_phone_numbers to find available product IDs."
          ),
        variables: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Per-call variables to pass to the agent prompt (e.g. { prospect_name: 'John', prospect_company: 'Acme' }). These override the agent's defaultVariables for this call."
          ),
        version_id: z
          .string()
          .optional()
          .describe("Agent version ID to use for this call. If omitted, uses the agent's current live configuration."),
      },
    },
    async (params) => {
      // Check if agent is conversation flow (blocked)
      const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);
      if (!agentResult.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(agentResult) }] };
      }
      const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO;
      if (agent.workflowType === "workflow_graph") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Smallest MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      const body: Record<string, unknown> = {
        agentId: params.agent_id,
        phoneNumber: params.phone_number,
      };
      if (params.from_product_id) {
        body.fromProductId = params.from_product_id;
      }
      if (params.variables) {
        body.variables = params.variables;
      }
      // For versioned agents, always include the version ID so the dispatcher
      // can resolve the agent config. Without it, calls get stuck in queue.
      if (params.version_id) {
        body.versionId = params.version_id;
      } else if (agent.activeVersionId) {
        body.versionId = agent.activeVersionId;
      }

      // MCP calls use test slots to avoid consuming production concurrency.
      // Without this, calls get stuck in the dispatcher queue if the org has
      // no production outbound slots reserved.
      const result = await atomsApi("POST", "/conversation/outbound", body, {
        "x-test-call": "true",
      });

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Outbound call initiated",
                callId: data?.conversationId ?? data?.callId,
                status: data?.status ?? "initiated",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
