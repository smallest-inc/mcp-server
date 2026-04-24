import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerPauseCampaign(server: McpServer) {
  server.registerTool(
    "pause_campaign",
    {
      description:
        "Pause a running campaign. Active calls in progress will complete, but no new calls will be initiated. Use start_campaign to resume.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID to pause"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "POST",
        `/campaign/${encodeURIComponent(params.campaign_id)}/pause`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Campaign ${params.campaign_id} is being paused. Active calls will complete, but no new calls will start.`,
          },
        ],
      };
    }
  );
}
