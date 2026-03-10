import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerMakeCall(server: McpServer) {
  server.registerTool(
    "make_call",
    {
      description:
        "Initiate an outbound phone call using a specific agent. The agent will call the provided phone number and follow its configured prompt.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to use for the call"),
        phone_number: z.string().describe("Phone number to call in E.164 format (e.g. +14155551234)"),
        from_number: z
          .string()
          .optional()
          .describe(
            "Caller ID / from number in E.164 format. Must be a number owned by your org. If omitted, a default number is used."
          ),
        variables: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Per-call variables to pass to the agent prompt (e.g. { prospect_name: 'John', prospect_company: 'Acme' }). These override the agent's defaultVariables for this call."
          ),
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
              text: "Smallest Atoms MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      const body: Record<string, unknown> = {
        agentId: params.agent_id,
        phoneNumber: params.phone_number,
      };
      if (params.from_number) {
        body.fromProductId = params.from_number;
      }
      if (params.variables) {
        body.variables = params.variables;
      }

      const result = await atomsApi("POST", "/conversation/outbound", body);

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
