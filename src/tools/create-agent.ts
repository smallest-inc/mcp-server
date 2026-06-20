import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveProModelId } from "../voice-catalog.js";

export function registerCreateAgent(server: McpServer) {
  server.registerTool(
    "create_agent",
    {
      description:
        "Create a new AI agent in your organization. The agent is created as a single_prompt agent with gpt-4.1 model and daniel voice (waves_lightning_v3_1) by default. The STT transcriber defaults to Pulse — change it (e.g. to pulse-legacy) via update_agent_config after creation. Returns the created agent's ID. Set the agent prompt via update_agent_prompt after creation.",
      inputSchema: {
        name: z.string().optional().describe("Name for the new agent"),
        description: z.string().optional().describe("Short description of what the agent does"),
        language: z
          .object({
            default: z
              .enum(["en", "hi", "mr", "gu", "ta", "es"])
              .optional()
              .describe("Default language code. Defaults to en."),
            supported: z
              .array(z.enum(["en", "hi", "mr", "gu", "ta", "es"]))
              .optional()
              .describe("List of supported language codes. Defaults to [default]."),
            switching_enabled: z
              .boolean()
              .optional()
              .describe("Enable automatic language switching during calls. Note: Tamil cannot be combined with other languages."),
          })
          .optional()
          .describe("Language configuration. Defaults to English."),
        synthesizer: z
          .object({
            voiceConfig: z
              .object({
                model: z
                  .enum([
                    "waves",
                    "waves_lightning_large",
                    "waves_lightning_v2",
                    "waves_lightning_v3_1",
                    "waves_lightning_v3",
                    "waves_lightning_v2_http",
                    "gpt-realtime",
                    "gpt-realtime-mini",
                    "other",
                  ])
                  .describe(
                    "Voice model to use. To use a Lightning V3.1 Pro voice, set model to waves_lightning_v3_1 and pick a voiceId whose supportedModels include 'lightning-v3.1-pro' (see get_voices) — Pro pool routing (modelId) is resolved and applied automatically."
                  ),
                voiceId: z.string().describe("Voice ID (e.g. rachel, nyah, etc.)"),
              })
              .optional()
              .describe("Voice model and ID configuration"),
            speed: z.number().optional().describe("Voice speed (0-2, default 1)"),
            consistency: z.number().optional().describe("Voice consistency (0-1, default 0.5)"),
            similarity: z.number().optional().describe("Voice similarity (0-1, default 0)"),
            enhancement: z.number().optional().describe("Voice enhancement (0, 1, or 2, default 1)"),
            sampleRate: z.number().optional().describe("Audio sample rate (8000, 16000, 24000, or 44100, default 24000)"),
          })
          .optional()
          .describe("Voice synthesizer configuration"),
        slm_model: z
          .enum(["electron", "electron-kogta", "gpt-4o", "gpt-4.1", "gpt-5.2", "gpt-realtime-mini", "gpt-realtime"])
          .optional()
          .describe("LLM model for the agent. Defaults to gpt-4.1."),
        global_prompt: z
          .string()
          .optional()
          .describe("Global system prompt for the agent (max 4000 chars). For the main prompt, use update_agent_prompt after creation."),
        first_message: z
          .string()
          .optional()
          .describe("First message the agent says when a call starts (max 500 chars)"),
        default_variables: z
          .record(z.string(), z.string())
          .optional()
          .describe("Default template variables for the agent prompt (e.g. { company_name: 'Acme' })"),
        knowledge_base_id: z
          .string()
          .optional()
          .describe("Knowledge base ID to attach to the agent"),
        allow_inbound_call: z.boolean().optional().describe("Whether to allow inbound calls (default true)"),
        allow_interruptions: z.boolean().optional().describe("Whether to allow user interruptions (default true)"),
        wait_for_user_to_speak_first: z.boolean().optional().describe("Wait for user to speak before agent starts (default false)"),
        smart_turn_config: z
          .object({
            isEnabled: z.boolean().optional(),
            waitTimeInSecs: z.number().optional().describe("Wait time in seconds (0-10)"),
          })
          .optional()
          .describe("Smart turn detection configuration"),
        voicemail_detection: z
          .object({
            enabled: z.boolean().optional().describe("Enable voicemail detection (default false)"),
            endText: z
              .string()
              .optional()
              .describe("Message to say before hanging up on voicemail (max 200 chars)"),
          })
          .optional()
          .describe("Voicemail detection configuration"),
        background_sound: z
          .enum(["", "office", "cafe", "call_center", "static"])
          .optional()
          .describe("Background sound during calls"),
        pronunciation_dicts: z
          .array(
            z.object({
              word: z.string().describe("The word to customize pronunciation for"),
              pronunciation: z.string().describe("How the word should be pronounced"),
            })
          )
          .optional()
          .describe("Custom pronunciation dictionary"),
        enable_style_guide: z.boolean().optional().describe("Enable conversational style guide (default true)"),
      },
    },
    async (params) => {
      const lang = params.language?.default ?? "en";
      const supported = params.language?.supported ?? [lang];

      const body: Record<string, unknown> = {
        origin: "mcp",
        workflowType: "single_prompt",
        language: {
          default: lang,
          supported,
          switching: { isEnabled: params.language?.switching_enabled ?? false },
        },
      };

      if (params.name !== undefined) body.name = params.name;
      if (params.description !== undefined) body.description = params.description;
      if (params.synthesizer !== undefined) {
        // Pro voices live only in the lightning-v3.1-pro pool; supply modelId so the
        // request routes there. Without it Waves falls back to the standard pool and
        // rejects the voice at call time ("Invalid Voice ID").
        let voiceConfig: Record<string, unknown> | undefined = params.synthesizer.voiceConfig;
        if (params.synthesizer.voiceConfig) {
          const modelId = await resolveProModelId(
            params.synthesizer.voiceConfig.model,
            params.synthesizer.voiceConfig.voiceId
          );
          if (modelId) voiceConfig = { ...params.synthesizer.voiceConfig, modelId };
        }

        body.synthesizer = {
          ...(voiceConfig && { voiceConfig }),
          ...(params.synthesizer.speed !== undefined && { speed: params.synthesizer.speed }),
          ...(params.synthesizer.consistency !== undefined && { consistency: params.synthesizer.consistency }),
          ...(params.synthesizer.similarity !== undefined && { similarity: params.synthesizer.similarity }),
          ...(params.synthesizer.enhancement !== undefined && { enhancement: params.synthesizer.enhancement }),
          ...(params.synthesizer.sampleRate !== undefined && { sampleRate: params.synthesizer.sampleRate }),
        };
      }
      if (params.slm_model !== undefined) body.slmModel = params.slm_model;
      if (params.global_prompt !== undefined) body.globalPrompt = params.global_prompt;
      if (params.default_variables !== undefined) body.defaultVariables = params.default_variables;
      if (params.knowledge_base_id !== undefined) body.globalKnowledgeBaseId = params.knowledge_base_id;
      if (params.allow_inbound_call !== undefined) body.allowInboundCall = params.allow_inbound_call;
      if (params.allow_interruptions !== undefined) body.allowInterruptions = params.allow_interruptions;
      if (params.wait_for_user_to_speak_first !== undefined) body.waitForUserToSpeakFirst = params.wait_for_user_to_speak_first;
      if (params.smart_turn_config !== undefined) body.smartTurnConfig = params.smart_turn_config;
      if (params.voicemail_detection !== undefined) body.voiceMailDetectionConfig = params.voicemail_detection;
      if (params.background_sound !== undefined) body.backgroundSound = params.background_sound;
      if (params.pronunciation_dicts !== undefined) body.pronunciationDicts = params.pronunciation_dicts;
      if (params.enable_style_guide !== undefined) body.enableStyleGuide = params.enable_style_guide;

      const result = await atomsApi("POST", "/agent", body);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const agentId = result.data?.data ?? result.data;

      const warnings: string[] = [];

      // firstMessage is not in the create validation schema, so set it via a follow-up PATCH
      if (params.first_message !== undefined) {
        const firstMsgResult = await atomsApi("PATCH", `/agent/${encodeURIComponent(agentId)}`, {
          firstMessage: params.first_message,
        });
        if (!firstMsgResult.ok) {
          warnings.push(
            `Agent created but failed to set first message: ${formatApiError(firstMsgResult)}. Use update_agent_config to set it manually.`
          );
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Agent created successfully",
                agentId,
                defaults_applied: {
                  workflowType: "single_prompt",
                  slmModel: params.slm_model ?? "gpt-4.1",
                  voice: params.synthesizer?.voiceConfig
                    ? `${params.synthesizer.voiceConfig.voiceId} (${params.synthesizer.voiceConfig.model})`
                    : "daniel (waves_lightning_v3_1)",
                },
                ...(warnings.length > 0 && { warnings }),
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
