import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerSearchAudienceMembers(server: McpServer) {
  server.registerTool(
    "search_audience_members",
    {
      description:
        "Search for members in an audience. Supports general search across all fields, or field-specific search (e.g. by phone number or name). Returns up to 10 results.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID to search in"),
        query: z
          .string()
          .optional()
          .describe("General search term — searches across all member fields"),
        field_filters: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Field-specific search filters (e.g. { phoneNumber: '+1415', firstName: 'John' }). Use either this or query, not both."
          ),
      },
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.query) {
        queryParts.push(`query=${encodeURIComponent(params.query)}`);
      }
      if (params.field_filters) {
        for (const [key, value] of Object.entries(params.field_filters)) {
          queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
      }

      if (queryParts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide either a general query or field_filters to search.",
            },
          ],
        };
      }

      const result = await atomsApi(
        "GET",
        `/audience/${encodeURIComponent(params.audience_id)}/members/search?${queryParts.join("&")}`
      );

      if (!result.ok) {
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
