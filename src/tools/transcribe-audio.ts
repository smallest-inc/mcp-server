import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";

import { optionalContext, requireContext } from "../context.js";
import { formatWavesApiError } from "../waves-api.js";

const getApiKey = () => requireContext("for Waves API calls").apiKey;
const wavesUrl = () => requireContext("for Waves API calls").wavesUrl;

export function registerTranscribeAudio(
  server: McpServer,
  options: { localFilesystem: boolean }
) {
  const { localFilesystem } = options;
  server.registerTool(
    "transcribe_audio",
    {
      // The advertised contract has to match the runtime one. Hosted, a path is
      // a path on the server, so the schema must not invite the model to send
      // one — it would burn a round trip on a guaranteed error.
      description:
        "Transcribe an audio file to text using Smallest AI's Pulse STT. Supports 32+ languages. " +
        "IMPORTANT: Always ask the user what language the audio is in before calling this tool. " +
        (localFilesystem
          ? "Pass a file path on the user's machine (e.g. ~/Desktop/recording.wav) or a publicly accessible URL. " +
            "Note: files uploaded to the chat sandbox are NOT accessible — ask the user for the actual file path on their machine or a URL instead."
          : "Pass a publicly accessible URL in audio_url. This server runs remotely, so local file paths are not readable — " +
            "to transcribe a file on your own machine, run the MCP server locally (npx @developer-smallestai/smallest-mcp-server)."),
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe(
            localFilesystem
              ? "Path to audio file on the user's machine (e.g. ~/Desktop/recording.wav, /Users/name/audio.mp3). " +
                "NOT sandbox paths. Either file_path or audio_url is required."
              : "Not supported on this server — it runs remotely, so paths refer to the server, not your machine. Use audio_url."
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
      // Only complain when the path is the source actually being used. An agent
      // that helpfully supplies both should get the URL honoured, as it is
      // locally, rather than a hard failure.
      if (params.file_path && !params.audio_url && !localFilesystem) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                "file_path is not available on the hosted server — paths there are on the server, " +
                "not your machine. Pass audio_url with a publicly reachable URL instead, or run the " +
                "MCP server locally (npx @developer-smallestai/smallest-mcp-server) to read local files.",
            },
          ],
        };
      }

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

      const url = `${wavesUrl()}/pulse/get_text?${queryParams.toString()}`;

      let response: Response;

      if (params.audio_url) {
        // Send URL as JSON
        response = await fetch(url, {
          // This tool calls fetch directly rather than through wavesApi, so the
          // request's abort signal has to be threaded in by hand — without it a
          // stalled upstream outlives the caller's deadline.
          signal: optionalContext()?.signal,
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
          // This tool calls fetch directly rather than through wavesApi, so the
          // request's abort signal has to be threaded in by hand — without it a
          // stalled upstream outlives the caller's deadline.
          signal: optionalContext()?.signal,
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
