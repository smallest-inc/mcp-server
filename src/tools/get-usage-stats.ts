import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerGetUsageStats(server: McpServer) {
  server.registerTool(
    "get_usage_stats",
    {
      description:
        "Get call usage statistics for your organization — total calls, pickup rate, duration, costs, and unique users reached. Each metric includes current period, previous period, and percent change. Useful for understanding usage patterns and costs.",
      inputSchema: {
        start_date: z
          .string()
          .optional()
          .describe("Start date (ISO 8601 datetime, e.g. 2025-01-15T00:00:00Z). Defaults to 7 days ago."),
        end_date: z
          .string()
          .optional()
          .describe("End date (ISO 8601 datetime, e.g. 2025-01-20T23:59:59Z). Defaults to now."),
        agent_name: z.string().optional().describe("Filter to a specific agent (partial match)"),
        campaign_id: z.string().optional().describe("Filter to a specific campaign by ID"),
        call_type: z
          .enum(["telephony_inbound", "telephony_outbound", "webcall", "chat"])
          .optional()
          .describe("Filter by call type"),
      },
    },
    async (params) => {
      const dateFrom =
        params.start_date ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const dateTo = params.end_date ?? new Date().toISOString();

      // If filtering by agent, resolve agent ID first
      let agentId: string | undefined;
      if (params.agent_name) {
        const agentsResult = await atomsApi(
          "GET",
          `/agent?page=1&offset=5&search=${encodeURIComponent(params.agent_name)}`
        );
        if (!agentsResult.ok) {
          return { content: [{ type: "text" as const, text: formatApiError(agentsResult) }] };
        }
        const agents = (agentsResult.data?.data?.agents ?? []) as IAgentDTO[];
        if (agents.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No agents found matching your criteria." }],
          };
        }
        agentId = agents[0]._id;
      }

      const queryParams = new URLSearchParams({
        dateFrom,
        dateTo,
      });
      if (agentId) queryParams.set("agentId", agentId);
      if (params.campaign_id) queryParams.set("campaignId", params.campaign_id);
      if (params.call_type) queryParams.set("callType", params.call_type);

      const result = await atomsApi("GET", `/analytics/summary?${queryParams.toString()}`);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      const summary = {
        period: { from: dateFrom, to: dateTo },
        ...(params.agent_name ? { agentFilter: params.agent_name } : {}),
        ...(params.campaign_id ? { campaignId: params.campaign_id } : {}),
        ...(params.call_type ? { callType: params.call_type } : {}),
        stats: data,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );
}
