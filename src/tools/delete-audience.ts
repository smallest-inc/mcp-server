import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteAudience(server: McpServer) {
  server.registerTool(
    "delete_audience",
    {
      description:
        "Delete an audience by ID. Cannot delete an audience that is linked to a campaign — remove or delete the campaign first.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID to delete"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "DELETE",
        `/audience/${encodeURIComponent(params.audience_id)}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Audience not found: ${params.audience_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Audience ${params.audience_id} deleted successfully.`,
          },
        ],
      };
    }
  );
}
