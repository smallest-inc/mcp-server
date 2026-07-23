import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerRenameBranch(server: McpServer) {
  server.registerTool(
    "rename_branch",
    {
      description: "Rename a branch. The default branch cannot be renamed, and 'main' is reserved. Use list_branches to find branch IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z.string().describe("The branch to rename (from list_branches)"),
        name: z.string().min(1).max(100).describe("New branch name (1-100 chars)"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "PATCH",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(params.branch_id)}`,
        { name: params.name }
      );
      if (!result.ok) {
        if (result.status === 404) {
          return { content: [{ type: "text" as const, text: `Branch not found: ${params.branch_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const branch = result.data?.data ?? result.data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Branch renamed to '${params.name}'.`, agentId: params.agent_id, branchId: params.branch_id, name: branch?.name ?? params.name },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
