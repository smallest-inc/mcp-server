import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerGetAgentPrompt(server: McpServer) {
  server.registerTool(
    "get_agent_prompt",
    {
      description:
        "Read the current system prompt / instructions for an agent. Returns the prompt text and any configured tools.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to read the prompt from"),
      },
    },
    async (params) => {
      // Step 1: Get agent to find workflowId and workflowType
      const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);

      if (!agentResult.ok) {
        if (agentResult.status === 404) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(agentResult) }] };
      }

      const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO;
      const workflowType = agent.workflowType;

      if (workflowType === "workflow_graph") {
        // For workflow_graph agents, the globalPrompt is on the agent itself
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  agent_id: agent._id,
                  agent_name: agent.name,
                  workflow_type: "workflow_graph",
                  global_prompt: agent.globalPrompt ?? null,
                  note: "This is a conversation flow agent. The globalPrompt is a high-level instruction; individual node prompts are configured in the UI. Smallest Atoms MCP does not support editing conversation flow agents.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 2: For single_prompt, fetch the workflow to get the prompt
      const workflowResult = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/workflow`
      );

      if (!workflowResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch workflow: ${formatApiError(workflowResult)}`,
            },
          ],
        };
      }

      const workflow = workflowResult.data?.data ?? workflowResult.data;
      // The API may return the prompt in different shapes:
      //   { prompt, tools }                          (direct on data)
      //   { singlePromptConfig: { prompt, tools } }  (wrapped)
      //   { data: { singlePromptConfig: { ... } } }  (double-wrapped)
      const promptSource =
        workflow?.data?.singlePromptConfig ??
        workflow?.singlePromptConfig ??
        workflow;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                agent_id: agent._id,
                agent_name: agent.name,
                workflow_type: "single_prompt",
                prompt: promptSource?.prompt ?? null,
                tools: promptSource?.tools ?? [],
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
