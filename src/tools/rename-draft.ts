import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerRenameDraft(server: McpServer) {
  server.registerTool(
    "rename_draft",
    {
      description:
        "Rename a draft to give it a more descriptive name. Useful when working with multiple drafts to keep them organized.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID to rename"),
        draft_name: z
          .string()
          .min(1)
          .max(100)
          .describe("New name for the draft (max 100 chars)"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "PATCH",
        `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(params.draft_id)}`,
        { draftName: params.draft_name }
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Draft ${params.draft_id} renamed to "${params.draft_name}".`,
          },
        ],
      };
    }
  );
}
