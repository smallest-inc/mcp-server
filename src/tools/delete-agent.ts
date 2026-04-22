import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteAgent(server: McpServer) {
  server.registerTool(
    "delete_agent",
    {
      description:
        "Archive (soft-delete) or unarchive an agent by its ID. Archived agents are inactive but can be recovered. Cannot archive agents with active campaigns.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to archive or unarchive"),
        unarchive: z
          .boolean()
          .optional()
          .describe("Set to true to unarchive (restore) a previously archived agent. Default is false (archive)."),
      },
    },
    async (params) => {
      const queryParam = params.unarchive ? "?on=false" : "";
      const result = await atomsApi(
        "DELETE",
        `/agent/${encodeURIComponent(params.agent_id)}/archive${queryParam}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const action = params.unarchive ? "unarchived" : "archived";
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${params.agent_id} has been ${action} successfully.`,
          },
        ],
      };
    }
  );
}
