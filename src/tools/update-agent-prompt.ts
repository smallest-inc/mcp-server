import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerUpdateAgentPrompt(server: McpServer) {
  server.registerTool(
    "update_agent_prompt",
    {
      description:
        "Update an agent's system prompt / instructions. Pass the full new prompt text. Only works for single_prompt agents.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to update"),
        prompt: z.string().describe("The new system prompt for the agent"),
      },
    },
    async (params: { agent_id: string; prompt: string }) => {
      // Step 1: Get the agent to find its workflowId and workflowType
      const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);

      if (!agentResult.ok) {
        if (agentResult.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(agentResult) }] };
      }

      const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO;
      const workflowId = agent?.workflowId;
      const workflowType: IAgentDTO["workflowType"] = agent?.workflowType;

      // Block conversation flow agents
      if (workflowType === "workflow_graph") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Smallest Atoms MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      if (!workflowId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent ${params.agent_id} has no workflow associated. Cannot update prompt.`,
            },
          ],
        };
      }

      // Get current workflow to preserve existing tools
      const workflowResult = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/workflow`
      );

      if (!workflowResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch existing workflow (needed to preserve tools): ${formatApiError(workflowResult)}`,
            },
          ],
        };
      }

      const workflowData = workflowResult.data?.data ?? workflowResult.data;
      const existingTools =
        workflowData?.data?.singlePromptConfig?.tools ??
        workflowData?.singlePromptConfig?.tools ??
        workflowData?.tools ??
        [];

      const result = await atomsApi("PATCH", `/workflow/${encodeURIComponent(workflowId)}`, {
        type: "single_prompt",
        singlePromptConfig: {
          prompt: params.prompt,
          tools: existingTools,
        },
      });

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${params.agent_id} prompt updated successfully.`,
          },
        ],
      };
    }
  );
}
