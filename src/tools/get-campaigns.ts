import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { ICampaignDTO } from "../types.js";

export function registerGetCampaigns(server: McpServer) {
  server.registerTool(
    "get_campaigns",
    {
      description:
        "List outbound calling campaigns for your organization. Shows campaign status, progress, agent used, audience, retry config, and execution details.",
      inputSchema: {
        status: z
          .enum(["draft", "scheduled", "processing", "running", "paused", "completed", "failed"])
          .optional()
          .describe("Filter by campaign status"),
        search: z
          .string()
          .optional()
          .describe("Search by campaign name (partial match, case-insensitive) or campaign ID (exact match)"),
        limit: z.number().default(20).describe("Max results per page (default 20, max 50)"),
        page: z.number().default(1).describe("Page number (default 1)"),
        sort_field: z
          .enum(["createdAt", "updatedAt"])
          .optional()
          .describe("Field to sort by (default createdAt)"),
        sort_order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort order (default desc)"),
      },
    },
    async (params) => {
      const limit = Math.min(params.limit, 50);

      const queryParams = new URLSearchParams({
        page: String(params.page),
        offset: String(limit),
      });

      if (params.status) queryParams.set("status", params.status);
      if (params.search) queryParams.set("search", params.search);
      if (params.sort_field) queryParams.set("sortField", params.sort_field);
      if (params.sort_order) queryParams.set("sortOrder", params.sort_order);

      const result = await atomsApi("GET", `/campaign?${queryParams.toString()}`);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const campaigns = (data?.campaigns ?? []).map((c: ICampaignDTO) => ({
        _id: c._id,
        name: c.name,
        description: c.description,
        status: c.status,
        agent: c.agent,
        audience: c.audience,
        participantsCount: c.participantsCount,
        maxRetries: c.maxRetries,
        retryAttempts: c.retryAttempts,
        retryDelay: c.retryDelay,
        scheduledAt: c.scheduledAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        currentExecution: c.currentExecution,
        error: c.error,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: campaigns.length,
                totalCount: data?.totalCampaignCount ?? data?.pagination?.total,
                page: params.page,
                campaigns,
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
