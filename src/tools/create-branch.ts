import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveLiveBranch } from "../versioning.js";

export function registerCreateBranch(server: McpServer) {
  server.registerTool(
    "create_branch",
    {
      description:
        "Create a new branch to work on a set of changes in isolation, without touching the live agent. The branch starts from a source branch's head (the live branch by default). Edit its draft with the usual tools (pass the new branch_id), publish_draft to commit, then make_branch_live to serve it.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        name: z.string().min(1).max(100).describe("Branch name (1-100 chars). Cannot be 'main'."),
        source_branch_id: z
          .string()
          .optional()
          .describe("Branch to fork from (from list_branches). Omit to fork from the live branch."),
      },
    },
    async (params) => {
      let sourceBranchId = params.source_branch_id;
      if (!sourceBranchId) {
        const live = await resolveLiveBranch(params.agent_id);
        if (!live.ok) return { content: [{ type: "text" as const, text: live.message }] };
        sourceBranchId = live.value.branchId;
      }

      const result = await atomsApi("POST", `/agent/${encodeURIComponent(params.agent_id)}/branches`, {
        sourceBranchId,
        name: params.name,
      });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const branch = result.data?.data ?? result.data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Branch '${params.name}' created.`,
                agentId: params.agent_id,
                branchId: branch?._id ?? null,
                name: branch?.name ?? params.name,
                sourceBranchId,
                hint: "Edit it with update_agent / add_agent_tool (pass this branch_id), publish_draft to commit, then make_branch_live to serve it.",
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
