import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteCampaign(server: McpServer) {
  server.registerTool(
    "delete_campaign",
    {
      description:
        "Delete a campaign. This permanently removes the campaign and its execution data.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID to delete"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "DELETE",
        `/campaign/${encodeURIComponent(params.campaign_id)}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Campaign not found: ${params.campaign_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Campaign ${params.campaign_id} deleted successfully.`,
          },
        ],
      };
    }
  );
}
