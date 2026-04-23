import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

/** Shared date range + filter params for analytics tools */
export const analyticsFilterSchema = {
  start_date: z
    .string()
    .optional()
    .describe("Start date (ISO 8601, e.g. 2025-01-15T00:00:00Z). Defaults to 7 days ago."),
  end_date: z
    .string()
    .optional()
    .describe("End date (ISO 8601, e.g. 2025-01-20T23:59:59Z). Defaults to now."),
  agent_name: z.string().optional().describe("Filter to a specific agent (partial match)"),
  campaign_id: z.string().optional().describe("Filter to a specific campaign by ID"),
  call_type: z
    .enum(["telephony_inbound", "telephony_outbound", "webcall", "chat"])
    .optional()
    .describe("Filter by call type"),
};

/** Shared date-specific param for single-day analytics */
export const dateScopedSchema = {
  date: z.string().describe("Date to query (YYYY-MM-DD format, e.g. 2025-01-15)"),
  agent_id: z.string().optional().describe("Filter to a specific agent by ID"),
};

interface AnalyticsFilterParams {
  start_date?: string;
  end_date?: string;
  agent_name?: string;
  campaign_id?: string;
  call_type?: string;
}

/**
 * Resolve filters and call an analytics endpoint. Handles agent name resolution,
 * date defaults, and error formatting.
 */
export async function callAnalyticsEndpoint(
  endpoint: string,
  params: AnalyticsFilterParams
): Promise<{ content: { type: "text"; text: string }[] }> {
  const dateFrom = params.start_date ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dateTo = params.end_date ?? new Date().toISOString();

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
        content: [{ type: "text" as const, text: `No agents found matching "${params.agent_name}".` }],
      };
    }
    agentId = agents[0]._id;
  }

  const queryParams = new URLSearchParams({ dateFrom, dateTo });
  if (agentId) queryParams.set("agentId", agentId);
  if (params.campaign_id) queryParams.set("campaignId", params.campaign_id);
  if (params.call_type) queryParams.set("callType", params.call_type);

  const result = await atomsApi("GET", `/analytics/${endpoint}?${queryParams.toString()}`);

  if (!result.ok) {
    return { content: [{ type: "text" as const, text: formatApiError(result) }] };
  }

  const data = result.data?.data ?? result.data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Call a date-scoped analytics endpoint (single day).
 */
export async function callDateScopedEndpoint(
  endpoint: string,
  params: { date: string; agent_id?: string }
): Promise<{ content: { type: "text"; text: string }[] }> {
  const queryParams = new URLSearchParams({ date: params.date });
  if (params.agent_id) queryParams.set("agentId", params.agent_id);

  const result = await atomsApi("GET", `/analytics/${endpoint}?${queryParams.toString()}`);

  if (!result.ok) {
    return { content: [{ type: "text" as const, text: formatApiError(result) }] };
  }

  const data = result.data?.data ?? result.data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
