import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetAudiences(server: McpServer) {
  server.registerTool(
    "get_audiences",
    {
      description:
        "List all audiences in your organization. Shows audience name, member count, linked campaigns, and the phone number column name. Audiences are contact lists used by campaigns for outbound calling.",
      inputSchema: {},
    },
    async () => {
      const result = await atomsApi("GET", "/audience");

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const audiences = result.data?.data ?? result.data;

      if (!Array.isArray(audiences) || audiences.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No audiences found." }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              audiences.map((a: any) => ({
                _id: a._id,
                name: a.name,
                description: a.description ?? null,
                phoneNumberColumnName: a.phoneNumberColumnName,
                memberCount: a.memberCount ?? 0,
                hasCampaigns: a.hasCampaigns ?? false,
                campaigns: a.campaigns ?? [],
                createdAt: a.createdAt,
                updatedAt: a.updatedAt,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
