import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveBranch } from "../versioning.js";

export function registerListRevisions(server: McpServer) {
  server.registerTool(
    "list_revisions",
    {
      description:
        "List the committed revisions on a specific branch, newest first. Revisions are branch-scoped — this returns one branch's history, not a global list. Shows revision number, label, who published it, and its security-check status. Use get_revision for a single revision's config.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch whose revisions to list (from list_branches). Omit for the live branch; if the agent has multiple branches you'll be asked to pick one."),
        limit: z.number().int().min(1).max(100).optional().describe("Max revisions to return (default 20)"),
        skip: z.number().int().min(0).optional().describe("Number of revisions to skip for pagination (default 0)"),
      },
    },
    async (params) => {
      const branch = await resolveBranch(params.agent_id, params.branch_id);
      if (!branch.ok) {
        return { content: [{ type: "text" as const, text: branch.message }] };
      }

      const queryParts: string[] = [];
      if (params.limit !== undefined) queryParts.push(`limit=${params.limit}`);
      if (params.skip !== undefined) queryParts.push(`skip=${params.skip}`);
      const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(branch.value.branchId)}/revisions${query}`
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const revisions = data?.revisions ?? data;
      const total = data?.total;

      if (!Array.isArray(revisions) || revisions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No committed revisions on branch ${branch.value.name ?? branch.value.branchId}.`,
            },
          ],
        };
      }

      const summary = revisions.map((v: any) => ({
        revisionId: v._id,
        revisionNumber: v.revisionNumber ?? v.versionNumber ?? null,
        label: v.label ?? null,
        publishedBy: v.publishedByName ?? v.publishedBy ?? null,
        publishedAt: v.publishedAt ?? null,
        securityCheck: v.securityCheck?.status ?? null,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { branchId: branch.value.branchId, revisions: summary, total: total ?? revisions.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
