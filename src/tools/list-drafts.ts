import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerListDrafts(server: McpServer) {
  server.registerTool(
    "list_drafts",
    {
      description:
        "List all active (unpublished) drafts for a versioned agent. Shows draft name, revision count, last editor, and last edit time. Useful to see what changes are in progress before deciding to publish or discard.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/drafts`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const drafts = result.data?.data ?? result.data;

      if (!Array.isArray(drafts) || drafts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No active drafts found for agent ${params.agent_id}.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              drafts.map((d: any) => ({
                draftId: d.draftId,
                draftName: d.draftName ?? null,
                sourceVersionId: d.sourceVersionId ?? null,
                editCount: d.editCount ?? null,
                lastEditor: d.lastEditorName ?? d.lastEditor ?? null,
                lastEdited: d.lastEdited ?? d.updatedAt ?? null,
                createdAt: d.createdAt ?? null,
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
