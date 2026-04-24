import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetDraft(server: McpServer) {
  server.registerTool(
    "get_draft",
    {
      description:
        "Get detailed information about a specific draft, including its latest revision, edit history (which sections changed per revision), and resolved config. Use list_drafts first to find draft IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID (returned by list_drafts, update_agent_config, or update_agent_prompt)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of edit history entries to return (default 50)"),
      },
    },
    async (params) => {
      let path = `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(params.draft_id)}`;
      if (params.limit !== undefined) {
        path += `?limit=${params.limit}`;
      }

      const result = await atomsApi("GET", path);

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Draft not found: ${params.draft_id}` }],
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
