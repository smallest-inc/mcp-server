import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { formatWavesApiError } from "../waves-api.js";

const WAVES_API_URL = "https://api.smallest.ai/waves/v1";
const getApiKey = () => {
  const key = process.env.ATOMS_API_KEY;
  if (!key) throw new Error("ATOMS_API_KEY environment variable is required");
  return key;
};

export function registerTextToSpeech(server: McpServer) {
  server.registerTool(
    "text_to_speech",
    {
      description:
        "Convert text to speech audio using Smallest AI's Lightning TTS. Saves the audio to a file and returns the file path. Supports multiple voices, languages, speeds, and output formats.",
      inputSchema: {
        text: z.string().describe("Text to synthesize into speech"),
        voice_id: z
          .string()
          .default("emily")
          .describe("Voice ID to use (e.g. emily, daniel, rachel, yuvika). Use get_voices to see available voices."),
        model: z
          .enum(["lightning-v3.1", "lightning-v3.2", "lightning-v2", "lightning-large"])
          .default("lightning-v3.1")
          .describe("TTS model to use. Default: lightning-v3.1"),
        language: z
          .string()
          .default("en")
          .describe("Language code (e.g. en, hi, ta, es). Default: en."),
        speed: z
          .number()
          .default(1.0)
          .describe("Speech speed multiplier (0.5-2.0). Default: 1.0"),
        sample_rate: z
          .number()
          .default(24000)
          .describe("Audio sample rate in Hz (8000, 16000, 24000, 44100). Default: 24000"),
        output_format: z
          .enum(["wav", "mp3", "pcm", "mulaw"])
          .default("wav")
          .describe("Output audio format. Default: wav"),
        output_path: z
          .string()
          .optional()
          .describe("File path to save the audio to. If omitted, saves to a temp file."),
      },
    },
    async (params) => {
      const body = {
        text: params.text,
        voice_id: params.voice_id,
        language: params.language,
        speed: params.speed,
        sample_rate: params.sample_rate,
        output_format: params.output_format,
      };

      const url = `${WAVES_API_URL}/${params.model}/get_speech`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let errorData: any;
        try {
          errorData = await response.json();
        } catch {
          errorData = { message: response.statusText };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: formatWavesApiError({ ok: false, status: response.status, data: errorData }),
            },
          ],
        };
      }

      // Read audio bytes
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      // Determine output path
      const ext = params.output_format === "mulaw" ? "wav" : params.output_format;
      const outputPath =
        params.output_path ?? join(tmpdir(), `tts-${Date.now()}.${ext}`);

      await writeFile(outputPath, audioBuffer);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Audio generated successfully",
                filePath: outputPath,
                format: params.output_format,
                sampleRate: params.sample_rate,
                sizeBytes: audioBuffer.length,
                voice: params.voice_id,
                model: params.model,
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
