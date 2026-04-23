import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerUpdateAgentPrompt(server: McpServer) {
  server.registerTool(
    "update_agent_prompt",
    {
      description:
        "Update an agent's system prompt / instructions. Pass the full new prompt text. Only works for single_prompt agents. Optionally update the first message too. For versioned agents, changes are saved as a draft — use publish_draft to make them live.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to update"),
        prompt: z.string().describe("The new system prompt for the agent"),
        first_message: z
          .string()
          .optional()
          .describe("Update the first message the agent says when a call starts (max 500 chars)"),
      },
    },
    async (params) => {
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
              text: "Smallest MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      const isVersioned = !!agent.activeVersionId;

      // --- Versioned agent: use draft flow ---
      if (isVersioned) {
        const createDraftResult = await atomsApi(
          "POST",
          `/agent/${encodeURIComponent(params.agent_id)}/drafts`,
          { sourceVersionId: agent.activeVersionId }
        );

        if (!createDraftResult.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create draft for prompt update: ${formatApiError(createDraftResult)}`,
              },
            ],
          };
        }

        const draft = createDraftResult.data?.data ?? createDraftResult.data;
        const draftId = draft?.draftId;

        const configBody: Record<string, unknown> = {
          singlePromptConfig: { prompt: params.prompt },
        };
        if (params.first_message !== undefined) {
          configBody.firstMessage = params.first_message;
        }

        const updateDraftResult = await atomsApi(
          "PATCH",
          `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(draftId)}/config`,
          configBody
        );

        if (!updateDraftResult.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Draft ${draftId} created but failed to update prompt: ${formatApiError(updateDraftResult)}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message: `Prompt${params.first_message !== undefined ? " and first message" : ""} saved to draft.`,
                  versioned: true,
                  agentId: params.agent_id,
                  draftId,
                  status: "draft",
                  hint: "Changes are in draft state (not live yet). Use publish_draft to make them live, or make_call with version_id to test the draft first.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // --- Non-versioned agent: direct workflow update ---
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

      // Update workflow prompt
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

      // Optionally update first message on the agent config
      if (params.first_message !== undefined) {
        const firstMsgResult = await atomsApi(
          "PATCH",
          `/agent/${encodeURIComponent(params.agent_id)}`,
          { firstMessage: params.first_message }
        );
        if (!firstMsgResult.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent prompt updated successfully, but failed to update first message: ${formatApiError(firstMsgResult)}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent ${params.agent_id} prompt and first message updated successfully.`,
            },
          ],
        };
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
