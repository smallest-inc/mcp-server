import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerPublishDraft(server: McpServer) {
  server.registerTool(
    "publish_draft",
    {
      description:
        "Publish a draft as a new version and activate it, making changes live. Use after update_agent_config or update_agent_prompt creates a draft on a versioned agent. Can also discard a draft instead of publishing.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID to publish (returned by update_agent_config or update_agent_prompt)"),
        action: z
          .enum(["publish", "discard"])
          .default("publish")
          .describe("Whether to publish the draft (make it live) or discard it"),
        label: z
          .string()
          .optional()
          .describe("Version label (max 200 chars, e.g. 'Changed voice to yuvika')"),
        description: z
          .string()
          .optional()
          .describe("Changelog description (max 2000 chars)"),
      },
    },
    async (params) => {
      const agentPath = `/agent/${encodeURIComponent(params.agent_id)}`;
      const draftPath = `${agentPath}/drafts/${encodeURIComponent(params.draft_id)}`;

      if (params.action === "discard") {
        const result = await atomsApi("DELETE", draftPath);

        if (!result.ok) {
          return { content: [{ type: "text" as const, text: formatApiError(result) }] };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Draft ${params.draft_id} discarded. No changes were applied to the live agent.`,
            },
          ],
        };
      }

      // Publish and activate
      const publishBody: Record<string, unknown> = { activate: true };
      if (params.label !== undefined) publishBody.label = params.label;
      if (params.description !== undefined) publishBody.description = params.description;

      const result = await atomsApi("POST", `${draftPath}/publish`, publishBody);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const version = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Draft published and activated successfully. Changes are now live.",
                agentId: params.agent_id,
                versionNumber: version?.versionNumber,
                versionId: version?._id,
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
