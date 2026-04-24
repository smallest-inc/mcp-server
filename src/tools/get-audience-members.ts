import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetAudienceMembers(server: McpServer) {
  server.registerTool(
    "get_audience_members",
    {
      description:
        "List members (contacts) in an audience with pagination. Each member has a data object containing their phone number and any other fields from the original CSV upload.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID"),
        page: z.number().int().min(1).optional().describe("Page number (default 1)"),
        page_size: z.number().int().min(1).max(100).optional().describe("Members per page (default 5)"),
      },
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.page !== undefined) queryParts.push(`page=${params.page}`);
      if (params.page_size !== undefined) queryParts.push(`offset=${params.page_size}`);
      const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

      const result = await atomsApi(
        "GET",
        `/audience/${encodeURIComponent(params.audience_id)}/members${query}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Audience not found: ${params.audience_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
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
