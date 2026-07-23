import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveBranch } from "../versioning.js";

export function registerGetBranchDraft(server: McpServer) {
  server.registerTool(
    "get_branch_draft",
    {
      description:
        "Get a branch's pending (unpublished) draft — its latest draft revision and edit history (which sections changed per edit). Each branch has at most one open draft. Use list_branches to see which branches have one (hasOpenDraft).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch whose draft to read (from list_branches). Omit for the live branch; if the agent has multiple branches you'll be asked to pick one."),
      },
    },
    async (params) => {
      const branch = await resolveBranch(params.agent_id, params.branch_id);
      if (!branch.ok) {
        return { content: [{ type: "text" as const, text: branch.message }] };
      }

      if (!branch.value.hasOpenDraft) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No open draft on branch ${branch.value.name ?? branch.value.branchId} — no unpublished changes.`,
            },
          ],
        };
      }

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(branch.value.branchId)}/draft`
      );
      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: "No open draft on this branch — no unpublished changes." }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
