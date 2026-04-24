import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerCreateCampaign(server: McpServer) {
  server.registerTool(
    "create_campaign",
    {
      description:
        "Create a new outbound calling campaign. Requires an agent and an audience (contact list). The campaign is created in draft status unless a scheduled time is provided, in which case it will be scheduled. Use start_campaign to begin dialing.",
      inputSchema: {
        name: z.string().min(1).describe("Campaign name"),
        description: z.string().optional().describe("Campaign description"),
        agent_id: z.string().describe("Agent ID to use for calls"),
        audience_id: z.string().describe("Audience ID (contact list) to call"),
        phone_number_ids: z
          .array(z.string())
          .optional()
          .describe("Phone number product IDs to use as caller IDs. Use get_phone_numbers to find IDs."),
        scheduled_at: z
          .string()
          .optional()
          .describe("Schedule campaign start time (ISO 8601, must be in the future). If omitted, campaign is created as a draft."),
        max_retries: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("Max retry attempts for failed/unanswered calls (0-10, default 3)"),
        retry_delay: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe("Minutes to wait between retry attempts (1-1440, default 15)"),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {
        name: params.name,
        agentId: params.agent_id,
        audienceId: params.audience_id,
      };
      if (params.description !== undefined) body.description = params.description;
      if (params.phone_number_ids !== undefined) body.phoneNumberIds = params.phone_number_ids;
      if (params.scheduled_at !== undefined) body.scheduledAt = params.scheduled_at;
      if (params.max_retries !== undefined) body.maxRetries = params.max_retries;
      if (params.retry_delay !== undefined) body.retryDelay = params.retry_delay;

      const result = await atomsApi("POST", "/campaign", body);

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
                message: `Campaign "${params.name}" created successfully.`,
                campaignId: data?._id,
                status: data?.status,
                participantsCount: data?.participantsCount,
                scheduledAt: data?.scheduledAt ?? null,
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
