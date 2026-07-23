import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDiff(server: McpServer) {
  server.registerTool(
    "diff",
    {
      description:
        "Compare two agent configs and show what changed, section by section (field paths with old/new values). Each side is a reference: a revision_id (from list_revisions) or \"<branch_id>:draft\" for a branch's open draft (branch_id from list_branches). E.g. diff a branch's draft against the live head to preview a publish.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        a: z.string().describe("Left side: a revision_id, or \"<branch_id>:draft\" for a branch's open draft"),
        b: z.string().describe("Right side: a revision_id, or \"<branch_id>:draft\" for a branch's open draft"),
      },
    },
    async (params) => {
      const query = `?a=${encodeURIComponent(params.a)}&b=${encodeURIComponent(params.b)}`;
      const result = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}/diff${query}`);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
