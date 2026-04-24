import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerActivateVersion(server: McpServer) {
  server.registerTool(
    "activate_version",
    {
      description:
        "Activate a specific published version, making it the live configuration for the agent. Use this to roll back to a previous version or switch between versions. The previously active version is automatically deactivated. Use list_versions to find version IDs.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_id: z.string().describe("The published version ID to activate"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "PATCH",
        `/agent/${encodeURIComponent(params.agent_id)}/versions/${encodeURIComponent(params.version_id)}/activate`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Version not found: ${params.version_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const activated = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Version activated successfully. This is now the live configuration.",
                agentId: params.agent_id,
                versionId: params.version_id,
                versionNumber: activated?.versionNumber,
                label: activated?.label ?? null,
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
