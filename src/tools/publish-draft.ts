import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { publishBranch, resolveBranch } from "../versioning.js";

export function registerPublishDraft(server: McpServer) {
  server.registerTool(
    "publish_draft",
    {
      description:
        "Publish a branch's pending draft edits, committing them as a new revision. If the branch is live, the changes serve immediately; otherwise use make_branch_live to serve them. " +
        "Publishing runs an async security check on the prompt; this tool waits for it and reports the real outcome — " +
        "if the check is still running after ~60s the changes aren't committed yet (they commit automatically once it passes), and if it fails the draft stays open so you can fix the prompt and publish again. " +
        "Can also discard the pending draft instead of publishing.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch to publish (from list_branches). Omit to use the live branch; if the agent has multiple branches you'll be asked to pick one."),
        action: z
          .enum(["publish", "discard"])
          .default("publish")
          .describe("Whether to publish the draft (commit it) or discard it"),
        label: z
          .string()
          .optional()
          .describe("Revision label (max 200 chars, e.g. 'Changed voice to yuvika')"),
      },
    },
    async (params) => {
      const branch = await resolveBranch(params.agent_id, params.branch_id);
      if (!branch.ok) {
        return { content: [{ type: "text" as const, text: branch.message }] };
      }

      if (params.action === "discard") {
        const result = await atomsApi(
          "DELETE",
          `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(branch.value.branchId)}/draft`
        );
        if (!result.ok) {
          if (result.status === 404) {
            return {
              content: [
                { type: "text" as const, text: "No pending draft to discard on this branch." },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: formatApiError(result) }] };
        }

        return {
          content: [
            { type: "text" as const, text: "Draft discarded. No changes were committed." },
          ],
        };
      }

      const published = await publishBranch(params.agent_id, branch.value, { label: params.label });
      if (!published.ok) {
        return { content: [{ type: "text" as const, text: published.message }] };
      }

      const { state, isLive, revisionId, revisionNumber, reason } = published.value;

      if (state === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message:
                    "Publish blocked: the prompt FAILED the security check, so nothing was committed. The draft is kept — fix the prompt and publish again.",
                  agentId: params.agent_id,
                  branchId: branch.value.branchId,
                  committed: false,
                  securityCheck: "failed",
                  reason: reason ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (state === "scanning") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message:
                    "Published; its security check is still running after ~60s so it isn't committed yet. It commits automatically once the check passes — re-check with list_revisions in a moment.",
                  agentId: params.agent_id,
                  branchId: branch.value.branchId,
                  committed: false,
                  securityCheck: "scanning",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: isLive
                  ? "Published and live. Changes are now serving."
                  : "Published to the branch. Use make_branch_live to serve this branch.",
                agentId: params.agent_id,
                branchId: branch.value.branchId,
                live: isLive,
                revisionId: revisionId ?? null,
                revisionNumber: revisionNumber ?? null,
                label: params.label ?? null,
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
