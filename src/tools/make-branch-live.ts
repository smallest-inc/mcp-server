import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerMakeBranchLive(server: McpServer) {
  server.registerTool(
    "make_branch_live",
    {
      description:
        "Make a branch's head revision the live (serving) configuration for the agent. Under the branch model only a branch head can serve — so this switches which branch the agent runs. Use list_branches to find branch IDs. The head must have passed its security check (otherwise this is rejected).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z.string().describe("The branch to make live (from list_branches)"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(params.branch_id)}/live`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Branch not found: ${params.branch_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const summary = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Branch is now live. Its head revision is the serving configuration.",
                agentId: params.agent_id,
                branchId: params.branch_id,
                branchName: summary?.branch?.name ?? null,
                headRevisionNumber: summary?.headRevisionNumber ?? null,
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
