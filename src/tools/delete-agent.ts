import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { toolError } from "./tool-error.js";

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
          return toolError(`Agent not found: ${params.agent_id}`);
        }
        return toolError(formatApiError(result));
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
