import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerExportCampaignLogs(server: McpServer) {
  server.registerTool(
    "export_campaign_logs",
    {
      description:
        "Export call logs for a campaign. Returns detailed call data grouped by audience member, including call status, duration, recording URL, transcript, cost, retry attempts, and post-call analytics.",
      inputSchema: {
        campaign_id: z.string().describe("The campaign ID to export logs for"),
        format: z
          .enum(["json", "csv"])
          .default("json")
          .describe("Export format (default json)"),
      },
    },
    async (params) => {
      const query = params.format === "csv" ? "?format=csv" : "";

      const result = await atomsApi(
        "GET",
        `/campaign/${encodeURIComponent(params.campaign_id)}/export/by-audience-member${query}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Campaign not found: ${params.campaign_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
