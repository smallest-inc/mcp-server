import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerUpdateVersion(server: McpServer) {
  server.registerTool(
    "update_version",
    {
      description:
        "Update metadata on a published version — label, description (release notes), or pin status. Pinned versions are highlighted in the version list for quick access. Does NOT change the version's configuration (published versions are immutable).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_id: z.string().describe("The published version ID to update"),
        label: z
          .string()
          .max(200)
          .optional()
          .describe("Version label (max 200 chars, e.g. 'Production v2')"),
        description: z
          .string()
          .max(2000)
          .optional()
          .describe("Release notes / changelog (max 2000 chars)"),
        is_pinned: z
          .boolean()
          .optional()
          .describe("Pin this version for quick access in the version list"),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.label !== undefined) body.label = params.label;
      if (params.description !== undefined) body.description = params.description;
      if (params.is_pinned !== undefined) body.isPinned = params.is_pinned;

      if (Object.keys(body).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields provided to update." }],
        };
      }

      const result = await atomsApi(
        "PATCH",
        `/agent/${encodeURIComponent(params.agent_id)}/versions/${encodeURIComponent(params.version_id)}`,
        body
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const updated = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Version metadata updated successfully.",
                versionId: params.version_id,
                label: updated?.label ?? params.label,
                description: updated?.description ?? params.description,
                isPinned: updated?.isPinned ?? params.is_pinned,
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
