import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerListBranches(server: McpServer) {
  server.registerTool(
    "list_branches",
    {
      description:
        "List the agent's branches. The live (serving) branch is marked with isLive; hasOpenDraft flags a branch that has unpublished draft changes waiting for publish_draft. Use this to find a branch_id (for make_branch_live) or to see where edits are in progress before publishing or discarding.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/branches`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const branches = data?.branches ?? data;

      if (!Array.isArray(branches) || branches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No branches found for agent ${params.agent_id}.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              branches.map((s: any) => ({
                branchId: s.branch?._id ?? null,
                name: s.branch?.name ?? null,
                isLive: !!s.isLive,
                hasOpenDraft: !!s.hasOpenDraft,
                headRevisionNumber: s.headRevisionNumber ?? null,
                revisionsCount: s.revisionsCount ?? null,
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
