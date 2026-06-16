import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";

import { formatWavesApiError } from "../waves-api.js";
import { WAVES_API_URL } from "../config.js";

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
        "Transcribe an audio file to text using Smallest AI's Pulse STT. Supports 32+ languages. " +
        "IMPORTANT: Always ask the user what language the audio is in before calling this tool. " +
        "Pass a file path on the user's machine (e.g. ~/Desktop/recording.wav) or a publicly accessible URL. " +
        "Note: files uploaded to the chat sandbox are NOT accessible — ask the user for the actual file path on their machine or a URL instead.",
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe(
            "Path to audio file on the user's machine (e.g. ~/Desktop/recording.wav, /Users/name/audio.mp3). " +
            "NOT sandbox paths. Either file_path or audio_url is required."
          ),
        audio_url: z
          .string()
          .optional()
          .describe("Publicly accessible URL of an audio file. Either file_path or audio_url is required."),
        language: z
          .string()
          .describe(
            "Language of the audio. REQUIRED — ask the user. " +
            "Use ISO 639-1 codes: en, hi, es, de, fr, it, pt, ta, mr, gu, bn, kn, ml, te, pa, or, ru, uk, pl, nl, sv, etc. " +
            "Use 'multi' only if the user explicitly says they don't know the language."
          ),
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
            {
              type: "text" as const,
              text: "Either file_path or audio_url is required. For files uploaded to the chat, ask the user for the actual path on their machine or a URL instead.",
            },
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
        // Expand ~ to home directory
        let filePath = params.file_path!;
        if (filePath.startsWith("~/")) {
          filePath = filePath.replace("~", process.env.HOME ?? "");
        }

        // Read file and send as binary
        let fileBuffer: Buffer;
        try {
          fileBuffer = await readFile(filePath);
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot read file: ${filePath}. ${err.code === "ENOENT" ? "File not found. Make sure the path is correct and the file exists on your machine (not in a chat sandbox)." : err.message}`,
              },
            ],
          };
        }

        const ext = filePath.split(".").pop()?.toLowerCase();
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
          body: new Uint8Array(fileBuffer),
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
