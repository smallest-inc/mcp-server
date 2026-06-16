import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { wavesApi, formatWavesApiError } from "../waves-api.js";

interface IWavesVoice {
  voiceId: string;
  displayName: string;
  description: string;
  audioPreview: string;
  tags: {
    accent?: string;
    language?: string[];
    gender?: "male" | "female";
    age?: string;
    usecases?: string[];
  };
  modelIds?: string[];
}

interface IWavesClonedVoice {
  voiceId: string;
  displayName: string;
  status: string;
  modelIds?: string[];
}

export function registerGetVoices(server: McpServer) {
  server.registerTool(
    "get_voices",
    {
      description:
        "List available voices for agents. Returns voice IDs, names, gender, language, and supported models. Use the voiceId with update_agent_config's synthesizer.voiceConfig to change an agent's voice. A voice whose supportedModels include 'lightning-v3.1-pro' is a Lightning V3.1 Pro voice (use it with the waves_lightning_v3_1 model). Optionally include your organization's cloned voices.",
      inputSchema: {
        gender: z
          .enum(["male", "female"])
          .optional()
          .describe("Filter by voice gender"),
        language: z
          .string()
          .optional()
          .describe("Filter by language (e.g. 'english', 'hindi'). Case-insensitive partial match."),
        include_cloned: z
          .boolean()
          .default(false)
          .describe("Include your organization's cloned voices (requires auth)"),
      },
    },
    async (params) => {
      // Fetch regular voices (public, no auth needed)
      const result = await wavesApi("GET", "/voice/get-all-models");

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatWavesApiError(result) }] };
      }

      let voices = (result.data?.voices ?? []) as IWavesVoice[];

      // Apply filters
      if (params.gender) {
        voices = voices.filter((v) => v.tags?.gender === params.gender);
      }
      if (params.language) {
        const lang = params.language.toLowerCase();
        voices = voices.filter((v) =>
          v.tags?.language?.some((l) => l.toLowerCase().includes(lang))
        );
      }

      const mapped = voices.map((v) => ({
        voiceId: v.voiceId,
        displayName: v.displayName,
        description: v.description,
        gender: v.tags?.gender ?? null,
        languages: v.tags?.language ?? [],
        accent: v.tags?.accent ?? null,
        age: v.tags?.age ?? null,
        usecases: v.tags?.usecases ?? [],
        supportedModels: v.modelIds ?? [],
        audioPreview: v.audioPreview,
      }));

      const output: Record<string, unknown> = {
        count: mapped.length,
        voices: mapped,
      };

      // Optionally fetch cloned voices
      if (params.include_cloned) {
        const clonedResult = await wavesApi("GET", "/voice-cloning", { auth: true });

        if (clonedResult.ok) {
          const clonedVoices = (clonedResult.data?.data ?? []) as IWavesClonedVoice[];
          const readyClones = clonedVoices.filter((v) => v.status === "ready" || v.status === "completed");

          output.clonedVoices = readyClones.map((v) => ({
            voiceId: v.voiceId,
            displayName: v.displayName,
            supportedModels: v.modelIds ?? [],
          }));
          output.clonedCount = readyClones.length;
        } else {
          output.clonedVoicesError = `Failed to fetch cloned voices: ${formatWavesApiError(clonedResult)}`;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );
}
