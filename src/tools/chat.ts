import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AtomsChatClient, ChatTurn } from "../chat-client.js";
import { optionalContext, requireContext } from "../context.js";

/**
 * Derive the realtime WebSocket base from the caller's HTTP API base:
 * https -> wss, http -> ws. Exported for tests — this is the whole reason a
 * chat against a non-prod backend was impossible before.
 */
export function wssBaseUrl(apiUrl: string): string {
  return apiUrl.replace(/^http/i, "ws");
}

/**
 * Kept back from the hosted deadline so the result is serialised and written
 * before the deadline's own timeout error would be.
 */
const DEADLINE_RESERVE_MS = 5_000;

/** Below this, a turn can't plausibly get a reply, so it isn't worth sending. */
const MIN_TURN_BUDGET_MS = 3_000;

/** Time left before the hosted deadline, or Infinity on stdio, which has none. */
function budgetLeftMs(deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? Infinity : deadlineAt - Date.now() - DEADLINE_RESERVE_MS;
}

function renderTranscript(turns: ChatTurn[]): string {
  return turns.map((t) => `${t.role === "user" ? "User " : "Agent"}: ${t.text}`).join("\n");
}

export function registerChatWithAgent(server: McpServer) {
  server.registerTool(
    "chat_with_agent",
    {
      description:
        "Hold a TEXT conversation with a published agent over the realtime chat WebSocket (mode=chat) — " +
        "no audio, no phone, just text in / text out. Sends each message in `messages` in order, waiting for " +
        "each agent turn to FULLY settle before sending the next — a turn can be several messages (a filler " +
        "while a tool runs, then the answer), so tool-using flows (auth, lookups) complete instead of being " +
        "cut off. Returns the full transcript. " +
        "Use this to test an agent's prompt/behaviour programmatically (e.g. an automated build → test → " +
        "evaluate → refine loop): run a scripted conversation, read the transcript, then adjust the prompt " +
        "with update_agent and run again. This places a real (chargeable) chat session on the agent. " +
        "Note: the agent must be published; to chat with unpublished draft changes use test_agent (mode=chat, include_draft=true).",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to chat with (must be a published agent)"),
        messages: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "User turns to send, in order. Each is sent only after the previous turn's reply arrives. " +
              "For realistic tests, write messages a real caller would send."
          ),
        variables: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Per-call values for {{key}} placeholders in the agent prompt"),
        reply_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(120000)
          .default(30000)
          .describe("Hard cap on how long to wait for a single agent turn before giving up on it"),
        settle_ms: z
          .number()
          .int()
          .min(500)
          .max(20000)
          .default(2500)
          .describe(
            "Silence after a SUBSTANTIVE agent message before the turn counts as finished. Fillers (messages " +
              "ending in '…', spoken while a tool runs) are waited on much longer automatically, so this can stay " +
              "small; raise it only if the agent sends its answer in several slow bursts."
          ),
        greeting_wait_ms: z
          .number()
          .int()
          .min(0)
          .max(15000)
          .default(3000)
          .describe("Time to wait after connecting for the agent's opening message (0 if it waits for the user first)"),
      },
    },
    async (params) => {
      let apiKey: string;
      let apiUrl: string;
      try {
        ({ apiKey, apiUrl } = requireContext("for chat"));
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }

      const client = new AtomsChatClient({
        apiKey,
        signal: optionalContext()?.signal,
        agentId: params.agent_id,
        baseWssUrl: wssBaseUrl(apiUrl),
        variables: params.variables,
      });

      const deadlineAt = optionalContext()?.deadlineAt;
      let turnsSent = 0;
      let connectError: string | null = null;
      let turnError: string | null = null;
      let greeting: string | null = null;

      try {
        const session = await client.connect(params.greeting_wait_ms);
        greeting = session.greeting;

        for (const message of params.messages) {
          // Hosted, the request has a hard deadline, and hitting it throws away
          // the transcript of a session that has already been charged. Spend
          // against it instead: shorten a turn's wait to what's left, and stop
          // with what we have once a turn couldn't fit.
          const left = budgetLeftMs(deadlineAt);
          if (left < MIN_TURN_BUDGET_MS) {
            turnError =
              `Stopped after ${turnsSent} of ${params.messages.length} turns: the hosted request ` +
              "budget ran out. The transcript so far is below; split the script into shorter runs " +
              "to cover the rest.";
            break;
          }
          try {
            await client.send(message, Math.min(params.reply_timeout_ms, left), params.settle_ms);
            turnsSent += 1;
          } catch (err) {
            turnError = err instanceof Error ? err.message : String(err);
            break; // session likely closed/errored — stop sending
          }
        }
        // Drain: give the last turn room to finish — including a natural agent
        // hangup (end_call) — before we tear the socket down, so we don't cut
        // the conversation short the way an immediate close would.
        if (!turnError) {
          const left = budgetLeftMs(deadlineAt);
          if (left > 0) await client.waitForClose(Math.min(params.settle_ms, left));
        }
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      } finally {
        client.close();
      }

      if (connectError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to start chat with agent ${params.agent_id}: ${connectError}`,
            },
          ],
        };
      }

      const result = {
        agent_id: params.agent_id,
        call_id: client.callId || null,
        greeting,
        turns_sent: turnsSent,
        turns_requested: params.messages.length,
        ended_reason: client.closedReason,
        error: turnError,
        transcript: client.transcript,
        conversation: renderTranscript(client.transcript),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
