import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerGetAgent(server: McpServer) {
  server.registerTool(
    "get_agent",
    {
      description:
        "Get full details for a single agent by ID, including voice config, model, prompt, language, call behavior settings, and workflow type.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to retrieve"),
      },
    },
    async (params) => {
      const result = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);

      if (!result.ok) {
        if (result.status === 404) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const agent = (result.data?.data ?? result.data) as IAgentDTO;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                _id: agent._id,
                name: agent.name,
                description: agent.description,
                workflowType: agent.workflowType,
                workflowId: agent.workflowId,
                activeVersionId: agent.activeVersionId ?? null,
                archived: agent.archived,
                totalCalls: agent.totalCalls ?? 0,
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt,

                // LLM & Knowledge
                slmModel: agent.slmModel,
                globalPrompt: agent.globalPrompt ?? null,
                globalKnowledgeBaseId: agent.globalKnowledgeBaseId ?? null,
                defaultVariables: agent.defaultVariables ?? {},

                // Voice
                synthesizer: agent.synthesizer,
                language: agent.language,
                firstMessage: agent.firstMessage,
                pronunciationDicts: agent.pronunciationDicts ?? [],
                backgroundSound: agent.backgroundSound,

                // Call behavior
                allowInboundCall: agent.allowInboundCall,
                allowInterruptions: agent.allowInterruptions,
                waitForUserToSpeakFirst: agent.waitForUserToSpeakFirst,
                muteUserUntilFirstBotResponse: agent.muteUserUntilFirstBotResponse,
                interruptionBackoffTimer: agent.interruptionBackoffTimer,

                // Detection & quality
                smartTurnConfig: agent.smartTurnConfig,
                voiceDetectionConfig: agent.voiceDetectionConfig,
                voiceMailDetectionConfig: agent.voiceMailDetectionConfig,
                denoisingConfig: agent.denoisingConfig,

                // Post-call & formatting
                callDispositionConfig: agent.callDispositionConfig ?? null,
                redactionConfig: agent.redactionConfig,
                enableStyleGuide: agent.enableStyleGuide,
                speechFormatting: agent.speechFormatting,

                // Timeouts
                llmIdleTimeoutConfig: agent.llmIdleTimeoutConfig,
                sessionTimeoutConfig: agent.sessionTimeoutConfig,
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
