import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveBranch } from "../versioning.js";

export function registerGetRevision(server: McpServer) {
  server.registerTool(
    "get_revision",
    {
      description:
        "Get a single committed revision — its metadata and fully resolved config. Use list_revisions to find revision IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        revision_id: z.string().describe("The revision ID (from list_revisions)"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch the revision belongs to (from list_branches). Omit for the live branch; if the agent has multiple branches you'll be asked to pick one."),
      },
    },
    async (params) => {
      const branch = await resolveBranch(params.agent_id, params.branch_id);
      if (!branch.ok) {
        return { content: [{ type: "text" as const, text: branch.message }] };
      }

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(branch.value.branchId)}/revisions/${encodeURIComponent(params.revision_id)}`
      );
      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Revision not found on this branch: ${params.revision_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
