import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerTestDraft(server: McpServer) {
  server.registerTool(
    "test_draft",
    {
      description:
        "Initiate a test call using a draft's configuration (before publishing). Supports webcall, chat, and telephony modes. Use this to verify draft changes work correctly before making them live.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID to test"),
        mode: z
          .enum(["webcall", "chat", "telephony"])
          .default("webcall")
          .describe("Test call mode: webcall (browser audio), chat (text only), or telephony (phone call)"),
        to_phone: z
          .string()
          .optional()
          .describe("Phone number in E.164 format. Required when mode is telephony."),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = { mode: params.mode };
      if (params.to_phone) {
        body.toPhone = params.to_phone;
      }

      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(params.draft_id)}/test-call`,
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
              {
                message: `Test call initiated for draft ${params.draft_id} in ${params.mode} mode`,
                ...data,
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
