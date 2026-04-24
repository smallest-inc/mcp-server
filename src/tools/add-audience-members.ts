import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerAddAudienceMembers(server: McpServer) {
  server.registerTool(
    "add_audience_members",
    {
      description:
        "Add members (contacts) to an existing audience. Each member must include the phone number column defined when the audience was created (use get_audience to check). Max 10,000 members per request. Duplicate phone numbers are skipped.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID to add members to"),
        members: z
          .array(z.record(z.string(), z.string()))
          .min(1)
          .describe(
            "Array of member objects. Each must include the audience's phone number column. Example: [{ phoneNumber: '+14155551234', firstName: 'John' }]"
          ),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "POST",
        `/audience/${encodeURIComponent(params.audience_id)}/members`,
        { members: params.members }
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
