import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDeleteBranch(server: McpServer) {
  server.registerTool(
    "delete_branch",
    {
      description:
        "Delete (archive) a branch, along with its revisions and open draft. The default branch cannot be deleted, and the live branch cannot be deleted — make another branch live first. Use list_branches to find branch IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z.string().describe("The branch to delete (from list_branches)"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(params.branch_id)}/archive`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return { content: [{ type: "text" as const, text: `Branch not found: ${params.branch_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: "Branch deleted.", agentId: params.agent_id, branchId: params.branch_id },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
