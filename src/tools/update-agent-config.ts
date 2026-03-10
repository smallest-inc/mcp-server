import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

export function registerUpdateAgentConfig(server: McpServer) {
  server.registerTool(
    "update_agent_config",
    {
      description:
        "Update an agent's configuration (name, language, first message, voice settings, model, variables, etc.). Only provided fields are updated. To update the agent's prompt/instructions, use update_agent_prompt instead.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to update"),
        name: z.string().optional().describe("New agent name"),
        description: z.string().optional().describe("Agent description"),
        language: z
          .object({
            default: z.string().optional().describe("Default language code (e.g. en, hi)"),
            supported: z.array(z.string()).optional().describe("List of supported language codes"),
            switching_enabled: z
              .boolean()
              .optional()
              .describe("Enable automatic language switching during calls"),
          })
          .optional()
          .describe("Language configuration"),
        first_message: z.string().optional().describe("First message when call starts (max 500 chars)"),
        synthesizer: z
          .object({
            voiceConfig: z
              .object({
                model: z
                  .enum(["waves", "waves_lightning_large", "waves_lightning_large_voice_clone"])
                  .describe("Voice model"),
                voiceId: z.string().describe("Voice ID (e.g. rachel, nyah, etc.)"),
              })
              .optional()
              .describe("Voice model and ID configuration"),
            speed: z.number().optional().describe("Voice speed (0-2)"),
            consistency: z.number().optional().describe("Voice consistency (0-1)"),
            similarity: z.number().optional().describe("Voice similarity (0-1)"),
          })
          .optional()
          .describe("Voice synthesizer configuration"),
        slm_model: z
          .enum(["electron", "gpt-4o", "gpt-4.1"])
          .optional()
          .describe("Inference LLM model for the agent"),
        default_variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Default variables for the agent. These are used when no per-call variables are provided. Example: { prospect_name: 'Default', company: 'Acme' }"
          ),
        allow_inbound_call: z.boolean().optional().describe("Whether to allow inbound calls"),
        smart_turn_config: z
          .object({
            isEnabled: z.boolean().optional(),
            waitTimeInSecs: z.number().optional(),
          })
          .optional()
          .describe("Smart turn detection configuration"),
        background_sound: z.string().optional().describe("Background sound option"),
      },
    },
    async (params) => {
      // Check if agent is conversation flow (blocked)
      const agentCheck = await atomsApi("GET", `/agent/${encodeURIComponent(params.agent_id)}`);
      if (!agentCheck.ok) {
        if (agentCheck.status === 404) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }] };
        }
        return { content: [{ type: "text" as const, text: formatApiError(agentCheck) }] };
      }
      const agent = (agentCheck.data?.data ?? agentCheck.data) as IAgentDTO;
      if (agent.workflowType === "workflow_graph") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Smallest Atoms MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      const body: Record<string, unknown> = {};
      if (params.name !== undefined) body.name = params.name;
      if (params.description !== undefined) body.description = params.description;
      if (params.first_message !== undefined) body.firstMessage = params.first_message;
      if (params.allow_inbound_call !== undefined) body.allowInboundCall = params.allow_inbound_call;
      if (params.smart_turn_config !== undefined) body.smartTurnConfig = params.smart_turn_config;
      if (params.background_sound !== undefined) body.backgroundSound = params.background_sound;
      if (params.slm_model !== undefined) body.slmModel = params.slm_model;
      if (params.default_variables !== undefined) body.defaultVariables = params.default_variables;

      // Language must be sent as a nested object
      if (params.language !== undefined) {
        body.language = {
          default: params.language.default,
          supported:
            params.language.supported ?? (params.language.default ? [params.language.default] : undefined),
          ...(params.language.switching_enabled !== undefined && {
            switching: { isEnabled: params.language.switching_enabled },
          }),
        };
      }

      // Synthesizer must be sent as a nested object matching backend schema
      if (params.synthesizer !== undefined) {
        body.synthesizer = {
          ...(params.synthesizer.voiceConfig && {
            voiceConfig: params.synthesizer.voiceConfig,
          }),
          ...(params.synthesizer.speed !== undefined && { speed: params.synthesizer.speed }),
          ...(params.synthesizer.consistency !== undefined && {
            consistency: params.synthesizer.consistency,
          }),
          ...(params.synthesizer.similarity !== undefined && { similarity: params.synthesizer.similarity }),
        };
      }

      if (Object.keys(body).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields provided to update." }],
        };
      }

      const result = await atomsApi("PATCH", `/agent/${encodeURIComponent(params.agent_id)}`, body);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${params.agent_id} config updated successfully. Fields updated: ${Object.keys(body).join(", ")}`,
          },
        ],
      };
    }
  );
}
