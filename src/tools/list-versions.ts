import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerListVersions(server: McpServer) {
  server.registerTool(
    "list_versions",
    {
      description:
        "List all published versions for a versioned agent, sorted by version number (newest first). Shows version number, label, who published it, whether it's active, and whether it's pinned. Use this to review version history or find a version to roll back to.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max versions to return (default 20)"),
        skip: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of versions to skip for pagination (default 0)"),
        is_pinned: z
          .boolean()
          .optional()
          .describe("Filter to only pinned versions (or only unpinned if false)"),
      },
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.limit !== undefined) queryParts.push(`limit=${params.limit}`);
      if (params.skip !== undefined) queryParts.push(`skip=${params.skip}`);
      if (params.is_pinned !== undefined) queryParts.push(`isPinned=${params.is_pinned}`);
      const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/versions${query}`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const versions = data?.versions ?? data;
      const total = data?.total;

      if (!Array.isArray(versions) || versions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No published versions found for agent ${params.agent_id}.`,
            },
          ],
        };
      }

      const summary = versions.map((v: any) => ({
        versionId: v._id,
        versionNumber: v.versionNumber,
        label: v.label ?? null,
        description: v.description ?? null,
        isActive: v.isActive ?? false,
        isPinned: v.isPinned ?? false,
        publishedBy: v.publishedByName ?? v.publishedBy ?? null,
        publishedAt: v.publishedAt ?? null,
        activatedBy: v.activatedByName ?? v.activatedBy ?? null,
        activatedAt: v.activatedAt ?? null,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { versions: summary, total: total ?? versions.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
