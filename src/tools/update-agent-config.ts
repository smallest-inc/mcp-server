import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { resolveProModelId } from "../voice-catalog.js";
import type { IAgentDTO } from "../types.js";

export function registerUpdateAgentConfig(server: McpServer) {
  server.registerTool(
    "update_agent_config",
    {
      description:
        "Update an agent's configuration (name, language, first message, voice settings, model, variables, etc.). Only provided fields are updated. To update the agent's prompt/instructions, use update_agent_prompt instead. For versioned agents, changes are saved as a draft — use publish_draft to make them live, or test the draft first via make_call with the draft's version_id.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to update"),
        name: z.string().optional().describe("New agent name"),
        description: z.string().optional().describe("Agent description"),
        language: z
          .object({
            default: z.enum(["en", "hi", "mr", "gu", "ta", "es"]).optional().describe("Default language code"),
            supported: z
              .array(z.enum(["en", "hi", "mr", "gu", "ta", "es"]))
              .optional()
              .describe("List of supported language codes. Note: Tamil cannot be combined with other languages."),
            switching_enabled: z
              .boolean()
              .optional()
              .describe("Enable automatic language switching during calls"),
          })
          .optional()
          .describe("Language configuration"),
        first_message: z
          .string()
          .optional()
          .describe("First message when call starts (max 500 chars)"),
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
                    "Voice model. To use a Lightning V3.1 Pro voice, set model to waves_lightning_v3_1 and pick a voiceId whose supportedModels include 'lightning-v3.1-pro' (see get_voices) — Pro pool routing (modelId) is resolved and applied automatically."
                  ),
                voiceId: z.string().describe("Voice ID (e.g. rachel, nyah, etc.)"),
              })
              .optional()
              .describe("Voice model and ID configuration"),
            speed: z.number().optional().describe("Voice speed (0-2)"),
            consistency: z.number().optional().describe("Voice consistency (0-1)"),
            similarity: z.number().optional().describe("Voice similarity (0-1)"),
            enhancement: z.number().optional().describe("Voice enhancement (0, 1, or 2)"),
            sampleRate: z.number().optional().describe("Audio sample rate (8000, 16000, 24000, or 44100)"),
          })
          .optional()
          .describe("Voice synthesizer configuration"),
        slm_model: z
          .enum(["electron", "electron-kogta", "gpt-4o", "gpt-4.1", "gpt-5.2", "gpt-realtime-mini", "gpt-realtime"])
          .optional()
          .describe("Inference LLM model for the agent"),
        transcriber_type: z
          .enum(["pulse", "pulse-legacy"])
          .optional()
          .describe(
            "Speech-to-text (STT) transcriber. 'pulse' is the current default and recommended option (widest language support). 'pulse-legacy' is the older model, deprecated and only available to allowlisted organizations — prefer 'pulse'. Note: 'gpt-realtime'/'gpt-realtime-mini' transcribers are set automatically when using a speech-to-speech LLM model and should not be set here."
          ),
        global_prompt: z
          .string()
          .optional()
          .describe("Global system prompt for the agent (max 4000 chars). This is separate from the workflow prompt updated via update_agent_prompt."),
        default_variables: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Default variables for the agent prompt. Example: { prospect_name: 'Default', company: 'Acme' }"
          ),
        knowledge_base_id: z
          .string()
          .optional()
          .describe("Knowledge base ID to attach to the agent"),
        allow_inbound_call: z.boolean().optional().describe("Whether to allow inbound calls"),
        allow_interruptions: z.boolean().optional().describe("Whether to allow user interruptions"),
        wait_for_user_to_speak_first: z
          .boolean()
          .optional()
          .describe("Wait for user to speak before agent starts"),
        mute_user_until_first_bot_response: z
          .boolean()
          .optional()
          .describe("Mute user audio until the bot sends its first response"),
        interruption_backoff_timer: z
          .number()
          .optional()
          .describe("Delay in seconds before agent resumes after interruption (0-10)"),
        smart_turn_config: z
          .object({
            isEnabled: z.boolean().optional(),
            waitTimeInSecs: z.number().optional().describe("Wait time in seconds (0-10)"),
          })
          .optional()
          .describe("Smart turn detection configuration"),
        voice_detection_config: z
          .object({
            confidence: z.number().optional().describe("Voice detection confidence threshold (0-1)"),
            minVolume: z.number().optional().describe("Minimum volume threshold (0-1)"),
            triggerTimeInSecs: z.number().optional().describe("Trigger time in seconds (0-10)"),
            releaseTimeInSecs: z.number().optional().describe("Release time in seconds (0-10)"),
          })
          .optional()
          .describe("Voice activity detection configuration"),
        voicemail_detection: z
          .object({
            enabled: z.boolean().optional().describe("Enable voicemail detection"),
            endText: z
              .string()
              .optional()
              .describe("Message to say before hanging up on voicemail (max 200 chars)"),
          })
          .optional()
          .describe("Voicemail detection configuration"),
        denoising_config: z
          .object({
            isEnabled: z.boolean().optional().describe("Enable audio denoising"),
          })
          .optional()
          .describe("Audio denoising configuration"),
        llm_idle_timeout_config: z
          .object({
            chatTimeoutTimeInSecs: z.number().optional().describe("Chat idle timeout (1-300 seconds)"),
            webcallTimeoutTimeInSecs: z.number().optional().describe("Webcall idle timeout (1-300 seconds)"),
            telephonyTimeoutTimeInSecs: z.number().optional().describe("Telephony idle timeout (1-300 seconds)"),
            maxRetries: z.number().optional().describe("Max retries before hanging up (1-10)"),
          })
          .optional()
          .describe("LLM idle timeout configuration per call type"),
        session_timeout_config: z
          .object({
            timeoutTimeInSecs: z.number().optional().describe("Max session duration (300-43200 seconds)"),
          })
          .optional()
          .describe("Session timeout configuration"),
        background_sound: z
          .enum(["", "office", "cafe", "call_center", "static"])
          .optional()
          .describe("Background sound option"),
        speech_formatting: z.boolean().optional().describe("Enable speech formatting"),
        pronunciation_dicts: z
          .array(
            z.object({
              word: z.string().describe("The word to customize pronunciation for"),
              pronunciation: z.string().describe("How the word should be pronounced"),
            })
          )
          .optional()
          .describe("Custom pronunciation dictionary"),
        redaction_config: z
          .object({
            isEnabled: z.boolean().describe("Enable PII redaction in transcripts"),
          })
          .optional()
          .describe("Redaction configuration"),
        call_disposition_config: z
          .string()
          .optional()
          .describe("Call disposition configuration prompt"),
        enable_style_guide: z.boolean().optional().describe("Enable conversational style guide"),
        telephony_product_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Telephony product IDs (see get_phone_numbers) to assign to this agent. Takes effect IMMEDIATELY — number assignment is agent metadata, not versioned config, so no draft/publish is involved. Replaces the agent's current numbers; assigning a number already attached to another agent moves it. Pass [] to unassign all."
          ),
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
              text: "Smallest MCP does not support conversation flow (workflow_graph) agents. Please use single_prompt agents or recreate the agent via create_agent.",
            },
          ],
        };
      }

      const body: Record<string, unknown> = {};
      if (params.name !== undefined) body.name = params.name;
      if (params.description !== undefined) body.description = params.description;
      if (params.first_message !== undefined) body.firstMessage = params.first_message;
      if (params.allow_inbound_call !== undefined) body.allowInboundCall = params.allow_inbound_call;
      if (params.allow_interruptions !== undefined) body.allowInterruptions = params.allow_interruptions;
      if (params.wait_for_user_to_speak_first !== undefined)
        body.waitForUserToSpeakFirst = params.wait_for_user_to_speak_first;
      if (params.mute_user_until_first_bot_response !== undefined)
        body.muteUserUntilFirstBotResponse = params.mute_user_until_first_bot_response;
      if (params.interruption_backoff_timer !== undefined)
        body.interruptionBackoffTimer = params.interruption_backoff_timer;
      if (params.smart_turn_config !== undefined) body.smartTurnConfig = params.smart_turn_config;
      if (params.voice_detection_config !== undefined) body.voiceDetectionConfig = params.voice_detection_config;
      if (params.voicemail_detection !== undefined) body.voiceMailDetectionConfig = params.voicemail_detection;
      if (params.denoising_config !== undefined) body.denoisingConfig = params.denoising_config;
      if (params.background_sound !== undefined) body.backgroundSound = params.background_sound;
      if (params.speech_formatting !== undefined) body.speechFormatting = params.speech_formatting;
      if (params.slm_model !== undefined) body.slmModel = params.slm_model;
      if (params.transcriber_type !== undefined) body.transcriberType = params.transcriber_type;
      if (params.global_prompt !== undefined) body.globalPrompt = params.global_prompt;
      if (params.default_variables !== undefined) body.defaultVariables = params.default_variables;
      if (params.knowledge_base_id !== undefined) body.globalKnowledgeBaseId = params.knowledge_base_id;
      if (params.pronunciation_dicts !== undefined) body.pronunciationDicts = params.pronunciation_dicts;
      if (params.redaction_config !== undefined) body.redactionConfig = params.redaction_config;
      if (params.call_disposition_config !== undefined) body.callDispositionConfig = params.call_disposition_config;
      if (params.enable_style_guide !== undefined) body.enableStyleGuide = params.enable_style_guide;
      if (params.telephony_product_ids !== undefined) body.telephonyProductId = params.telephony_product_ids;
      if (params.llm_idle_timeout_config !== undefined) body.llmIdleTimeoutConfig = params.llm_idle_timeout_config;
      if (params.session_timeout_config !== undefined) body.sessionTimeoutConfig = params.session_timeout_config;

      // Language must be sent as a nested object.
      // The switching sub-object requires ALL fields (no defaults in update schema),
      // so merge with the agent's current switching config to preserve existing values.
      if (params.language !== undefined) {
        const currentSwitching = agent.language?.switching;

        body.language = {
          default: params.language.default ?? agent.language?.default,
          supported:
            params.language.supported ??
            (params.language.default ? [params.language.default] : agent.language?.supported),
          switching: {
            isEnabled: params.language.switching_enabled ?? currentSwitching?.isEnabled ?? false,
            minWordsForDetection: currentSwitching?.minWordsForDetection ?? 2,
            strongSignalThreshold: currentSwitching?.strongSignalThreshold ?? 0.7,
            weakSignalThreshold: currentSwitching?.weakSignalThreshold ?? 0.3,
            minConsecutiveForWeakThresholdSwitch:
              currentSwitching?.minConsecutiveForWeakThresholdSwitch ?? 2,
          },
        };
      }

      // Synthesizer must be sent as a nested object matching backend schema
      if (params.synthesizer !== undefined) {
        // Pro voices live only in the lightning-v3.1-pro pool; supply modelId so the
        // request routes there. The versioned draft-config path persists modelId
        // verbatim (no catalog lookup), so omitting it silently downgrades Pro voices
        // to the standard pool, which rejects them at call time ("Invalid Voice ID").
        let voiceConfig: Record<string, unknown> | undefined = params.synthesizer.voiceConfig;
        if (params.synthesizer.voiceConfig) {
          const modelId = await resolveProModelId(
            params.synthesizer.voiceConfig.model,
            params.synthesizer.voiceConfig.voiceId
          );
          if (modelId) voiceConfig = { ...params.synthesizer.voiceConfig, modelId };
        }

        body.synthesizer = {
          ...(voiceConfig && {
            voiceConfig,
          }),
          ...(params.synthesizer.speed !== undefined && { speed: params.synthesizer.speed }),
          ...(params.synthesizer.consistency !== undefined && {
            consistency: params.synthesizer.consistency,
          }),
          ...(params.synthesizer.similarity !== undefined && { similarity: params.synthesizer.similarity }),
          ...(params.synthesizer.enhancement !== undefined && { enhancement: params.synthesizer.enhancement }),
          ...(params.synthesizer.sampleRate !== undefined && { sampleRate: params.synthesizer.sampleRate }),
        };
      }

      if (Object.keys(body).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields provided to update." }],
        };
      }

      const isVersioned = !!agent.activeVersionId;

      // --- Non-versioned agent: direct update ---
      if (!isVersioned) {
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

      // --- Versioned agent: create draft → update draft config ---

      // Separate metadata fields (can still be updated directly on the agent).
      // Must mirror the backend's metadataOnlyFields: telephonyProductId in
      // particular ONLY works here — the direct PATCH writes the number→agent
      // binding into the products registry. Sent via the draft path it is
      // silently inert: the draft accepts the key but nothing ever assigns the
      // number, so it looks like it worked and inbound routing never changes.
      const metadataFields: Record<string, unknown> = {};
      const configFields: Record<string, unknown> = {};
      const METADATA_KEYS = ["name", "description", "allowInboundCall", "telephonyProductId"];

      for (const [key, value] of Object.entries(body)) {
        if (METADATA_KEYS.includes(key)) {
          metadataFields[key] = value;
        } else {
          configFields[key] = value;
        }
      }

      const messages: string[] = [];

      // Update metadata directly if any
      if (Object.keys(metadataFields).length > 0) {
        const metaResult = await atomsApi(
          "PATCH",
          `/agent/${encodeURIComponent(params.agent_id)}`,
          metadataFields
        );
        if (metaResult.ok) {
          messages.push(`Metadata updated directly: ${Object.keys(metadataFields).join(", ")}`);
        } else {
          messages.push(`Failed to update metadata: ${formatApiError(metaResult)}`);
        }
      }

      // Update config via draft if any config fields
      if (Object.keys(configFields).length > 0) {
        // Step 1: Create draft from active version
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
                text: messages.length > 0
                  ? `${messages.join(". ")}. However, failed to create draft for config changes: ${formatApiError(createDraftResult)}`
                  : `Failed to create draft: ${formatApiError(createDraftResult)}`,
              },
            ],
          };
        }

        const draft = createDraftResult.data?.data ?? createDraftResult.data;
        const draftId = draft?.draftId;

        // Step 2: Update draft config
        const updateDraftResult = await atomsApi(
          "PATCH",
          `/agent/${encodeURIComponent(params.agent_id)}/drafts/${encodeURIComponent(draftId)}/config`,
          configFields
        );

        if (!updateDraftResult.ok) {
          messages.push(`Draft ${draftId} created but failed to update config: ${formatApiError(updateDraftResult)}`);
        } else {
          messages.push(`Config changes saved to draft. Fields: ${Object.keys(configFields).join(", ")}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message: messages.join(". "),
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

      // Only metadata was updated
      return {
        content: [
          {
            type: "text" as const,
            text: messages.join(". "),
          },
        ],
      };
    }
  );
}
