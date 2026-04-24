import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetDraftDiff(server: McpServer) {
  server.registerTool(
    "get_draft_diff",
    {
      description:
        "Compare a draft against its source version (or a specific published version) to see what changed. Shows unchanged sections and detailed diffs for modified sections. Useful before publishing to review changes.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID to diff"),
        compare_to: z
          .string()
          .optional()
          .describe("Version ID to compare against. If omitted, compares against the draft's source version."),
      },
    },
    async (params) => {
      let path = `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(params.draft_id)}/diff`;
      if (params.compare_to) {
        path += `?compareTo=${encodeURIComponent(params.compare_to)}`;
      }

      const result = await atomsApi("GET", path);

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
