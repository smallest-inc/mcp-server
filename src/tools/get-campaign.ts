import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { toolError } from "./tool-error.js";

export function registerGetCampaign(server: McpServer) {
  server.registerTool(
    "get_campaign",
    {
      description:
        "Get detailed information about a specific campaign, including status, execution progress, events timeline, and metrics (participants, contacts called, contacts connected).",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/campaign/${encodeURIComponent(params.campaign_id)}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return toolError(`Campaign not found: ${params.campaign_id}`);
        }
        return toolError(formatApiError(result));
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
