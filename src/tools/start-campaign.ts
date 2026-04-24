import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerStartCampaign(server: McpServer) {
  server.registerTool(
    "start_campaign",
    {
      description:
        "Start a campaign to begin dialing contacts. Works on campaigns in draft or paused status. For paused campaigns, this resumes from where it left off. The campaign enters processing state and begins making calls asynchronously.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID to start"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "POST",
        `/campaign/${encodeURIComponent(params.campaign_id)}/start`
      );

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
                message: "Campaign is being processed. Calls will begin shortly.",
                campaignId: params.campaign_id,
                taskId: data?.taskId ?? null,
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
