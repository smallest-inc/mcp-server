import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";

import { formatWavesApiError } from "../waves-api.js";

const WAVES_API_URL = "https://api.smallest.ai/waves/v1";
const getApiKey = () => {
  const key = process.env.ATOMS_API_KEY;
  if (!key) throw new Error("ATOMS_API_KEY environment variable is required");
  return key;
};

export function registerTranscribeAudio(server: McpServer) {
  server.registerTool(
    "transcribe_audio",
    {
      description:
        "Transcribe an audio file to text using Smallest AI's Pulse STT. Supports 32+ languages with auto-detection. Pass either a file path or a URL. Returns transcription with optional word timestamps, speaker diarization, and emotion detection.",
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe("Local file path to an audio file (wav, mp3, flac, ogg, m4a, webm). Either file_path or audio_url is required."),
        audio_url: z
          .string()
          .optional()
          .describe("URL of an audio file to transcribe. Either file_path or audio_url is required."),
        language: z
          .string()
          .default("multi")
          .describe("Language code (e.g. en, hi, es, de, fr) or 'multi' for auto-detection. Default: multi."),
        word_timestamps: z
          .boolean()
          .default(false)
          .describe("Include word-level timestamps with confidence scores"),
        diarize: z
          .boolean()
          .default(false)
          .describe("Enable speaker diarization (identify different speakers)"),
        emotion_detection: z
          .boolean()
          .default(false)
          .describe("Detect emotions in speech"),
        redact_pii: z
          .boolean()
          .default(false)
          .describe("Redact personally identifiable information from transcription"),
      },
    },
    async (params) => {
      if (!params.file_path && !params.audio_url) {
        return {
          content: [
            { type: "text" as const, text: "Either file_path or audio_url is required." },
          ],
        };
      }

      const queryParams = new URLSearchParams({
        language: params.language,
      });
      if (params.word_timestamps) queryParams.set("word_timestamps", "true");
      if (params.diarize) queryParams.set("diarize", "true");
      if (params.emotion_detection) queryParams.set("emotion_detection", "true");
      if (params.redact_pii) queryParams.set("redact_pii", "true");

      const url = `${WAVES_API_URL}/pulse/get_text?${queryParams.toString()}`;

      let response: Response;

      if (params.audio_url) {
        // Send URL as JSON
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: JSON.stringify({ url: params.audio_url }),
        });
      } else {
        // Read file and send as binary
        const fileBuffer = await readFile(params.file_path!);
        const ext = params.file_path!.split(".").pop()?.toLowerCase();
        const contentTypeMap: Record<string, string> = {
          wav: "audio/wav",
          mp3: "audio/mpeg",
          flac: "audio/flac",
          ogg: "audio/ogg",
          m4a: "audio/mp4",
          webm: "audio/webm",
        };
        const contentType = contentTypeMap[ext ?? ""] ?? "application/octet-stream";

        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            Authorization: `Bearer ${getApiKey()}`,
          },
          body: fileBuffer,
        });
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatWavesApiError({ ok: false, status: response.status, data }),
            },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    }
  );
}
