import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteAudienceMembers(server: McpServer) {
  server.registerTool(
    "delete_audience_members",
    {
      description:
        "Remove specific members from an audience by their member IDs. Use get_audience_members or search_audience_members to find member IDs. If all members are removed, the audience itself may be deleted.",
      inputSchema: {
        audience_id: z.string().describe("The audience ID"),
        member_ids: z
          .array(z.string())
          .min(1)
          .describe("Array of member IDs to remove"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "DELETE",
        `/audience/${encodeURIComponent(params.audience_id)}/members`,
        { memberIds: params.member_ids }
      );

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
                message: `${data?.deletedCount ?? 0} member(s) removed.`,
                ...data,
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
