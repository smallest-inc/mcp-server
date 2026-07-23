import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveBranch } from "../versioning.js";

export function registerTestAgent(server: McpServer) {
  server.registerTool(
    "test_agent",
    {
      description:
        "Start a test call against a branch — its committed head by default, its open draft (include_draft: true) to try unpublished changes, or a specific revision_id. Modes: webcall (default) or chat return LiveKit connection details; telephony places a real call to to_phone (required, E.164).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch to test (from list_branches). Omit for the live branch; if the agent has multiple branches you'll be asked to pick one."),
        include_draft: z
          .boolean()
          .optional()
          .describe("Test the branch's open draft (unpublished changes) instead of its committed head. Cannot be combined with revision_id."),
        revision_id: z
          .string()
          .optional()
          .describe("Test a specific committed revision. Cannot be combined with include_draft."),
        mode: z
          .enum(["webcall", "chat", "telephony"])
          .optional()
          .describe("Test mode. Default webcall. telephony places a real call to to_phone."),
        to_phone: z
          .string()
          .optional()
          .describe("Destination phone number in E.164 — required when mode is telephony."),
      },
    },
    async (params) => {
      if (params.include_draft && params.revision_id) {
        return {
          content: [
            { type: "text" as const, text: "Provide either include_draft or revision_id, not both." },
          ],
        };
      }
      if (params.mode === "telephony" && !params.to_phone) {
        return {
          content: [{ type: "text" as const, text: "to_phone (E.164) is required when mode is telephony." }],
        };
      }

      const branch = await resolveBranch(params.agent_id, params.branch_id);
      if (!branch.ok) {
        return { content: [{ type: "text" as const, text: branch.message }] };
      }

      const body: Record<string, unknown> = { mode: params.mode ?? "webcall" };
      if (params.include_draft !== undefined) body.includeDraft = params.include_draft;
      if (params.revision_id !== undefined) body.revisionId = params.revision_id;
      if (params.to_phone !== undefined) body.toPhone = params.to_phone;

      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/branches/${encodeURIComponent(branch.value.branchId)}/test-call`,
        body
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Test call initiated (${params.mode ?? "webcall"})`, branchId: branch.value.branchId, ...data },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
