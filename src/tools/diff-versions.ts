import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDiffVersions(server: McpServer) {
  server.registerTool(
    "diff_versions",
    {
      description:
        "Compare two published versions side-by-side to see exactly what changed between them. Shows unchanged sections and detailed diffs for modified config sections (voice, prompt, LLM, language, etc.). Use list_versions to find version IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_a: z.string().describe("First version ID to compare"),
        version_b: z.string().describe("Second version ID to compare"),
      },
    },
    async (params) => {
      const query = `?versionA=${encodeURIComponent(params.version_a)}&versionB=${encodeURIComponent(params.version_b)}`;

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/versions/diff${query}`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
