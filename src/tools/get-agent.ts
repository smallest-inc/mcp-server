import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerGetAgent(server: McpServer) {
  server.registerTool(
    "get_agent",
    {
      description:
        "Get full details for a single agent by ID, including defaultVariables, voice config, model, redaction settings, and workflow type.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to retrieve"),
      },
    },
    async (params) => {
      const result = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);

      if (!result.ok) {
        if (result.status === 404) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const agent = (result.data?.data ?? result.data) as IAgentDTO;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _id: agent._id,
                name: agent.name,
                description: agent.description,
                slmModel: agent.slmModel,
                synthesizer: agent.synthesizer,
                language: agent.language,
                workflowType: agent.workflowType,
                workflowId: agent.workflowId,
                defaultVariables: agent.defaultVariables ?? {},
                firstMessage: agent.firstMessage,
                allowInboundCall: agent.allowInboundCall,
                backgroundSound: agent.backgroundSound,
                smartTurnConfig: agent.smartTurnConfig,
                denoisingConfig: agent.denoisingConfig,
                redactionConfig: agent.redactionConfig,
                archived: agent.archived,
                totalCalls: agent.totalCalls ?? 0,
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt,
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
