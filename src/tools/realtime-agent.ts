import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import WebSocket from "ws";

const ATOMS_WS_URL = "wss://api.smallest.ai/atoms/v1/agent/connect";

const getApiKey = () => {
  const key = process.env.ATOMS_API_KEY;
  if (!key) throw new Error("ATOMS_API_KEY environment variable is required");
  return key;
};

interface ChatResult {
  call_id?: string;
  session_id?: string;
  reply: string;
  transcripts: Array<{ speaker?: string; text: string; is_final?: boolean }>;
}

function extractTranscript(msg: any): { speaker?: string; text: string; is_final?: boolean } | null {
  const text = msg.text ?? msg.transcript ?? msg.content;
  if (typeof text !== "string" || text.length === 0) return null;
  const speaker = msg.role ?? msg.speaker ?? msg.source;
  const is_final = msg.is_final ?? msg.final;
  return { speaker, text, is_final };
}

function isAgentTranscript(t: { speaker?: string }): boolean {
  if (!t.speaker) return true;
  const s = t.speaker.toLowerCase();
  return s === "agent" || s === "assistant" || s === "bot";
}

export function registerRealtimeAgent(server: McpServer) {
  server.registerTool(
    "realtime_agent_chat",
    {
      description:
        "Send a single text message to an Atoms realtime agent and return its reply. " +
        "Opens a WebSocket session in chat mode, sends the message, collects the agent's transcript response, " +
        "then closes the session. Use this for one-shot text interactions; the returned call_id can be used " +
        "with conversation retrieval endpoints for the full transcript later.",
      inputSchema: {
        agent_id: z.string().describe("The Atoms agent ID to connect to"),
        text: z.string().describe("Text message to send to the agent"),
        variables: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Per-call prompt variables passed to the agent. Values must be string, number, or boolean. " +
              "Reserved keys (call_id, conversation_type, user_number, agent_number) are stripped server-side."
          ),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(300000)
          .default(60000)
          .describe("Maximum time to wait for the agent's reply, in milliseconds. Default: 60000 (60s)."),
      },
    },
    async (params) => {
      const apiKey = getApiKey();

      const query = new URLSearchParams({
        agent_id: params.agent_id,
        mode: "chat",
      });
      if (params.variables) {
        query.set("variables", JSON.stringify(params.variables));
      }

      const url = `${ATOMS_WS_URL}?${query.toString()}`;

      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const result: ChatResult = { reply: "", transcripts: [] };

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
          };

          const timer = setTimeout(
            () => finish(new Error(`Timed out after ${params.timeout_ms}ms waiting for agent reply`)),
            params.timeout_ms
          );

          let sessionReady = false;
          const agentTextParts: string[] = [];

          ws.on("open", () => {
            // Session is established on receipt of session.created, not on socket open.
          });

          ws.on("message", (raw) => {
            let msg: any;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }

            switch (msg.type) {
              case "session.created":
                result.session_id = msg.session_id;
                result.call_id = msg.call_id;
                sessionReady = true;
                ws.send(JSON.stringify({ type: "input_text.send", text: params.text }));
                break;

              case "transcript": {
                const t = extractTranscript(msg);
                if (!t) break;
                result.transcripts.push(t);
                if (isAgentTranscript(t) && (t.is_final ?? true)) {
                  agentTextParts.push(t.text);
                }
                break;
              }

              case "agent_stop_talking":
                result.reply = agentTextParts.join(" ").trim();
                ws.send(JSON.stringify({ type: "session.close" }));
                break;

              case "session.closed":
                if (!result.reply) result.reply = agentTextParts.join(" ").trim();
                finish();
                break;

              case "error":
                finish(new Error(msg.message ?? msg.error ?? "Realtime agent returned error"));
                break;
            }
          });

          ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));

          ws.on("close", (code, reason) => {
            if (!sessionReady) {
              finish(
                new Error(
                  `WebSocket closed before session.created (code ${code}${reason ? `, ${reason.toString()}` : ""})`
                )
              );
              return;
            }
            if (!result.reply) result.reply = agentTextParts.join(" ").trim();
            finish();
          });
        });
      } catch (err) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: err instanceof Error ? err.message : String(err),
                  call_id: result.call_id,
                  session_id: result.session_id,
                  partial_reply: result.reply || undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                call_id: result.call_id,
                session_id: result.session_id,
                reply: result.reply,
                transcript_count: result.transcripts.length,
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
