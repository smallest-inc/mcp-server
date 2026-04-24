import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetAudience(server: McpServer) {
  server.registerTool(
    "get_audience",
    {
      description:
        "Get details for a specific audience by ID, including name, description, and phone number column name.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/audience/${encodeURIComponent(params.audience_id)}`
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
