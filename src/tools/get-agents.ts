import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerGetAgents(server: McpServer) {
  server.registerTool(
    "get_agents",
    {
      description:
        "List AI agents in your organization. Returns agent configuration including voice, LLM model, language settings, and call statistics. Supports pagination, filtering, and sorting.",
      inputSchema: {
        agent_name: z.string().optional().describe("Filter by agent name (partial match, case-insensitive)"),
        include_archived: z.boolean().default(false).describe("Include archived agents"),
        workflow_type: z
          .enum(["single_prompt", "workflow_graph"])
          .optional()
          .describe("Filter by workflow type"),
        limit: z.number().default(20).describe("Max results per page (default 20, max 50)"),
        page: z.number().default(1).describe("Page number (default 1)"),
        sort_field: z
          .enum(["createdAt", "updatedAt", "totalCalls", "name", "workflowType"])
          .optional()
          .describe("Field to sort by (default createdAt)"),
        sort_order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort order (default desc)"),
      },
    },
    async (params) => {
      const limit = Math.min(params.limit, 50);

      const queryParams = new URLSearchParams({
        page: String(params.page),
        offset: String(limit),
      });

      if (params.agent_name) {
        queryParams.set("search", params.agent_name);
      }
      if (params.include_archived) {
        queryParams.set("archived", "true");
      }
      if (params.workflow_type) {
        queryParams.set("type", params.workflow_type);
      }
      if (params.sort_field) {
        queryParams.set("sortField", params.sort_field);
      }
      if (params.sort_order) {
        queryParams.set("sortOrder", params.sort_order);
      }

      const result = await atomsApi("GET", `/agent?${queryParams.toString()}`);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const agents = (data?.agents ?? []).map((agent: IAgentDTO) => ({
        _id: agent._id,
        name: agent.name,
        description: agent.description,
        workflowType: agent.workflowType,
        slmModel: agent.slmModel,
        synthesizer: agent.synthesizer,
        language: agent.language,
        firstMessage: agent.firstMessage,
        allowInboundCall: agent.allowInboundCall,
        allowInterruptions: agent.allowInterruptions,
        backgroundSound: agent.backgroundSound,
        activeVersionId: agent.activeVersionId ?? null,
        archived: agent.archived,
        totalCalls: agent.totalCalls ?? 0,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: agents.length,
                totalCount: data?.totalCount,
                totalPages: data?.totalPages,
                page: params.page,
                hasMore: data?.hasMore ?? false,
                agents,
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
