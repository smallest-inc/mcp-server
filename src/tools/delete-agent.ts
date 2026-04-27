import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteAgent(server: McpServer) {
  server.registerTool(
    "delete_agent",
    {
      description:
        "Archive (soft-delete) an agent by its ID. Archived agents are inactive. Cannot archive agents with active campaigns. Unarchiving is not supported — to restore an agent, use app.smallest.ai.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to archive"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "DELETE",
        `/agent/${encodeURIComponent(params.agent_id)}/archive`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${params.agent_id} has been archived successfully.`,
          },
        ],
      };
    }
  );
}
