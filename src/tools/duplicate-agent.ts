import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { getAuthenticatedOrg } from "../auth.js";

export function registerDuplicateAgent(server: McpServer) {
  server.registerTool(
    "duplicate_agent",
    {
      description:
        "Duplicate an existing agent, creating a new agent with the same configuration. The new agent is created in the target organization (defaults to your own org). Useful for creating variants of an agent for testing or A/B comparisons.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to duplicate"),
        target_organization_id: z
          .string()
          .optional()
          .describe(
            "Target organization ID to create the duplicate in. If omitted, duplicates into your own organization."
          ),
      },
    },
    async (params) => {
      const org = await getAuthenticatedOrg();
      const targetOrgId = params.target_organization_id ?? org.orgId;

      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/duplicate`,
        { targetOrganizationId: targetOrgId }
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Agent duplicated successfully.",
                originalAgentId: params.agent_id,
                newAgentId: data?._id ?? null,
                targetOrganizationId: targetOrgId,
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
