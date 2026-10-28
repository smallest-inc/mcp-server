import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { wavesApi, formatWavesApiError } from "../waves-api.js";
import { toolError } from "./tool-error.js";

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
        "List available voices for agents. Returns up to 50 voices by default; use limit and offset to page while hasMore is true. Filter by name, model, gender, or language. Use voiceId with update_agent's synthesizer.voiceConfig. Optionally include your organization's cloned voices; gender and language filters apply to catalog voices only.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum voices per page (1–200)"),
        offset: z.number().int().min(0).default(0).describe("Number of matching voices to skip"),
        name: z.string().optional().describe("Case-insensitive substring of voice name or ID"),
        model: z.string().optional().describe("Case-insensitive exact supported model ID"),
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
        return toolError(formatWavesApiError(result));
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

      const matchesCommonFilters = (v: { voiceId: string; displayName: string; modelIds?: string[] }) => {
        const name = params.name?.toLowerCase();
        const model = params.model?.toLowerCase();
        return (!name || v.displayName.toLowerCase().includes(name) || v.voiceId.toLowerCase().includes(name)) &&
          (!model || v.modelIds?.some((id) => id.toLowerCase() === model));
      };
      voices = voices.filter(matchesCommonFilters);
      let clones: IWavesClonedVoice[] = [];
      let clonedVoicesError: string | undefined;

      // Optionally fetch cloned voices
      if (params.include_cloned) {
        const clonedResult = await wavesApi("GET", "/voice-cloning", { auth: true });

        if (clonedResult.ok) {
          const clonedVoices = (clonedResult.data?.data ?? []) as IWavesClonedVoice[];
          clones = clonedVoices.filter((v) => (v.status === "ready" || v.status === "completed") && matchesCommonFilters(v));
        } else {
          clonedVoicesError = `Failed to fetch cloned voices: ${formatWavesApiError(clonedResult)}`;
        }
      }

      // Page the combined result, so cloned voices cannot bypass the response limit.
      const total = voices.length + clones.length;
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const page = [...voices.map((voice) => ({ voice, cloned: false as const })),
        ...clones.map((voice) => ({ voice, cloned: true as const }))].slice(offset, offset + limit);
      const compact = (v: { voiceId: string; displayName: string; modelIds?: string[] }) => ({
        voiceId: v.voiceId,
        displayName: v.displayName,
        supportedModels: v.modelIds ?? [],
      });
      const output: Record<string, unknown> = {
        count: page.filter((v) => !v.cloned).length,
        total,
        hasMore: offset + page.length < total,
        voices: page.filter((v) => !v.cloned).map(({ voice }) => compact(voice)),
      };
      if (params.include_cloned) {
        output.clonedVoices = page.filter((v) => v.cloned).map(({ voice }) => compact(voice));
        output.clonedCount = clones.length;
        if (clonedVoicesError) output.clonedVoicesError = clonedVoicesError;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }
  );
}
