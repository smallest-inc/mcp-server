import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO, ICallCountsLogEntry } from "../types.js";

export function registerListCalls(server: McpServer) {
  server.registerTool(
    "list_calls",
    {
      description:
        "Search and list calls across your organization. Use this to browse calls with filters (by status, type, date range, agent, phone number, campaign). Returns a summary list with metadata, duration, cost, and disconnection reasons. For detailed info about a specific call (status, transcript, errors, debugging), use debug_call instead.",
      inputSchema: {
        call_status: z
          .enum(["pending", "in_queue", "active", "completed", "failed", "no_answer", "busy", "cancelled"])
          .optional()
          .describe("Filter by call status"),
        call_type: z
          .enum(["telephony_inbound", "telephony_outbound", "webcall", "chat"])
          .optional()
          .describe("Filter by call type"),
        agent_name: z.string().optional().describe("Filter by agent name (partial match, case-insensitive)"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        phone_number: z
          .string()
          .optional()
          .describe("Filter by phone number (client-side match on fromNumber or toNumber)"),
        start_date: z.string().optional().describe("Start date filter (ISO 8601, e.g. 2025-01-15)"),
        end_date: z.string().optional().describe("End date filter (ISO 8601, e.g. 2025-01-20)"),
        has_errors: z.boolean().optional().describe("If true, only return calls that have errors"),
        limit: z.number().default(20).describe("Max results per page (default 20, max 100)"),
        page: z.number().default(1).describe("Page number (default 1)"),
      },
    },
    async (params) => {
      const limit = Math.min(params.limit, 100);

      // If filtering by agent name, first resolve the agent ID
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
            content: [
              {
                type: "text" as const,
                text: `No agents found matching "${params.agent_name}" in your organization.`,
              },
            ],
          };
        }
        agentId = agents[0]._id;
      }

      // Use the analytics call-counts-log endpoint for filtered call logs
      const queryParams = new URLSearchParams({
        page: String(params.page),
        limit: String(limit),
      });

      if (agentId) queryParams.set("agentId", agentId);
      if (params.campaign_id) queryParams.set("campaignId", params.campaign_id);
      if (params.call_status) queryParams.set("callStatus", params.call_status);
      if (params.call_type) queryParams.set("callType", params.call_type);
      if (params.start_date) queryParams.set("dateFrom", params.start_date);
      if (params.end_date) queryParams.set("dateTo", params.end_date);

      const result = await atomsApi("GET", `/analytics/call-counts-log?${queryParams.toString()}`);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      let calls = (data?.calls ?? []) as ICallCountsLogEntry[];

      // Apply client-side filters not supported by the API
      if (params.phone_number) {
        const phone = params.phone_number;
        calls = calls.filter((c) => c.fromNumber?.includes(phone) || c.toNumber?.includes(phone));
      }

      if (params.has_errors) {
        calls = calls.filter((c) => c.callStatus === "failed" || c.disconnectionReason !== "-");
      }

      const enrichedLogs = calls.map((call) => ({
        callId: call.callId,
        callType: call.callType,
        callStatus: call.callStatus,
        callDurationMs: call.callDurationMs,
        callLatencyMs: call.callLatencyMs,
        costSpent: call.costSpent,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        agentId: call.agentId,
        agentName: call.agentName,
        campaignName: call.campaignName,
        disconnectionReason: call.disconnectionReason,
        source: call.source,
        timestamp: call.timestamp,
        recordingUrl: call.recordingUrl,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                total: data?.totalCalls ?? data?.totalCount ?? enrichedLogs.length,
                returned: enrichedLogs.length,
                page: params.page,
                totalPages: data?.totalPages,
                logs: enrichedLogs,
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
