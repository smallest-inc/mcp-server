import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { formatWavesApiError } from "../waves-api.js";
import { WAVES_API_URL } from "../config.js";

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
        "Convert text to speech audio using Smallest AI's Lightning TTS. Saves the audio file to the specified path. " +
        "IMPORTANT: Always ask the user where to save the file before calling. Suggest ~/Desktop/<name>.wav as default. " +
        "Do NOT retry if successful — the file is saved even if inline audio rendering fails.",
      inputSchema: {
        text: z.string().describe("Text to synthesize into speech"),
        output_path: z
          .string()
          .describe("File path to save the audio to (e.g. ~/Desktop/output.wav). Ask the user where to save."),
        voice_id: z
          .string()
          .default("emily")
          .describe("Voice ID to use (e.g. emily, daniel, rachel, yuvika). Use get_voices to see available voices."),
        model: z
          .enum(["lightning_v3.1", "lightning_v3.1_pro"])
          .default("lightning_v3.1")
          .describe(
            "TTS model. lightning_v3.1 (default) or lightning_v3.1_pro (Lightning V3.1 Pro — higher quality, curated voices). Default: lightning_v3.1"
          ),
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
          .enum(["wav", "mp3", "pcm", "ulaw", "alaw"])
          .default("wav")
          .describe("Output audio format. Default: wav"),
      },
    },
    async (params) => {
      const body = {
        text: params.text,
        voice_id: params.voice_id,
        model: params.model,
        language: params.language,
        speed: params.speed,
        sample_rate: params.sample_rate,
        output_format: params.output_format,
      };

      // Waves v4: single /tts endpoint, model selected via the request body.
      const url = `${WAVES_API_URL}/tts`;

      // The Accept header signals the desired audio container to the server.
      const acceptByFormat: Record<string, string> = {
        wav: "audio/wav",
        mp3: "audio/mpeg",
        pcm: "audio/pcm",
        ulaw: "audio/basic",
        alaw: "audio/x-alaw-basic",
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: acceptByFormat[params.output_format] ?? "audio/wav",
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

      // Expand ~ to home directory
      let outputPath = params.output_path;
      if (outputPath.startsWith("~/")) {
        outputPath = outputPath.replace("~", homedir());
      }

      await writeFile(outputPath, audioBuffer);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Audio saved successfully",
                filePath: outputPath,
                format: params.output_format,
                sampleRate: params.sample_rate,
                sizeBytes: audioBuffer.length,
                durationEstimate: `~${Math.round(audioBuffer.length / (params.sample_rate * 2))}s`,
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
