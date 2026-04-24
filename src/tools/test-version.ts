import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerTestVersion(server: McpServer) {
  server.registerTool(
    "test_version",
    {
      description:
        "Initiate a test call using a specific published version's configuration. Supports webcall, chat, and telephony modes. Use this to test a non-active version before activating it (e.g. verifying a rollback candidate).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_id: z.string().describe("The published version ID to test"),
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
        `/agent/${encodeURIComponent(params.agent_id)}/versions/${encodeURIComponent(params.version_id)}/test-call`,
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
                message: `Test call initiated for version ${params.version_id} in ${params.mode} mode`,
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
