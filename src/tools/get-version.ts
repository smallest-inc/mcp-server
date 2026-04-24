import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerGetVersion(server: McpServer) {
  server.registerTool(
    "get_version",
    {
      description:
        "Get full details for a specific published version, including its resolved configuration across all sections (voice, LLM, language, prompt, detection, timeouts, etc.). Use list_versions to find version IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_id: z.string().describe("The published version ID"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/versions/${encodeURIComponent(params.version_id)}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Version not found: ${params.version_id}` }],
          };
        }
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
