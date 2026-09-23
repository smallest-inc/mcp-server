import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { parseEventJsonFields, summarizeDiagnostics } from "./debug-call-diagnostics.js";
import type { ICallToolCallDTO, ICallTurnStatsDTO, ICallUsageDTO } from "../types.js";

export function registerDebugCall(server: McpServer) {
  server.registerTool(
    "debug_call",
    {
      description:
        "Get detailed info about a single call — use this to check call status, debug failures, or get transcripts. Returns call status, failure reasons, errors, transcript, post-call analytics, latency metrics, cost breakdown, variables, voice/model config at time of call, and full event timeline. Also returns the call's LLM insights: `usage` (prompt/completion/cached tokens, LLM call count, prompt-cache hit %), `turns` (per-turn LLM TTFB, generation time, turn time, tokens) and `toolCalls` (per-tool execution time and context tokens). When the runtime recorded them, also returns `diagnostics` (build, region, endpoints, effective turn and barge-in settings, call-setup timings, recording anchor, media quality), `turnOutcomes` (one row per turn attempt, including turns where the agent never spoke: outcome, why the turn ended, empty STT finals, caller audio level, caller-perceived latency), `bargeIns` (one row per barge-in: hold, gate verdict, talk-over time, recovery) and `timelineCompleteness` (whether any runtime events were lost). Works for calls in any state (queued, in-progress, completed, failed). Use a callId (e.g. CALL-1234567890-abc123).",
      inputSchema: {
        call_id: z.string().describe("The callId to debug (e.g. CALL-1234567890-abc123)"),
      },
    },
    async (params) => {
      // Fetch both the MongoDB call log (rich metadata) and ClickHouse events in parallel
      const [logsResult, eventsResult] = await Promise.all([
        atomsApi("GET", `/conversation/${encodeURIComponent(params.call_id)}`),
        atomsApi("GET", `/analytics/conversation-details/${encodeURIComponent(params.call_id)}`),
      ]);

      // If the conversation logs endpoint fails, fall back to events-only
      if (!logsResult.ok && !eventsResult.ok) {
        const errorMsg = logsResult.status === 404
          ? `Call not found: ${params.call_id}. Make sure you're using the full callId (e.g. CALL-1234567890-abc123).`
          : formatApiError(logsResult);
        return { content: [{ type: "text" as const, text: errorMsg }] };
      }

      const logsData = logsResult.ok ? (logsResult.data?.data ?? logsResult.data) : null;
      const eventsData = eventsResult.ok ? (eventsResult.data?.data ?? eventsResult.data) : null;

      // Build structured debug output
      const output: Record<string, unknown> = {};

      // Core call info (prefer MongoDB data, fallback to events data)
      output.callId = logsData?.callId ?? params.call_id;
      output.status = logsData?.status ?? null;
      output.callFailureReason = logsData?.callFailureReason ?? null;
      output.type = logsData?.type ?? null;
      output.from = logsData?.from ?? eventsData?.fromNumber ?? null;
      output.to = logsData?.to ?? eventsData?.toNumber ?? null;
      output.duration = logsData?.duration ?? eventsData?.callDurationMs ?? null;
      output.callCost = logsData?.callCost ?? null;
      output.recordingUrl = logsData?.recordingUrl ?? null;
      output.disconnectionReason = logsData?.disconnectionReason ?? null;

      // SIP code and category behind the disconnect
      if (logsData?.disconnectDetails) {
        output.disconnectDetails = logsData.disconnectDetails;
      }

      // Transcript
      output.transcript = logsData?.transcript ?? eventsData?.transcript ?? null;

      // Post-call analytics (summaries, disposition metrics)
      if (logsData?.postCallAnalytics) {
        output.postCallAnalytics = logsData.postCallAnalytics;
      }

      // Extracted variables
      if (logsData?.variables) {
        output.variables = logsData.variables;
      }

      // Perceived latency (post-call audio analysis: caller stops -> bot audible)
      if (logsData?.turnLatencyMetrics) {
        output.turnLatencyMetrics = logsData.turnLatencyMetrics;
      }

      // LLM insights, derived by the backend from the runtime's own metrics.
      // `usage` carries the prompt-cache hit %, `turns` the per-turn LLM timings.
      if (logsData?.usage) {
        output.usage = logsData.usage as ICallUsageDTO;
      }
      if (Array.isArray(logsData?.turns) && logsData.turns.length > 0) {
        output.turns = logsData.turns as ICallTurnStatsDTO[];
      }
      if (Array.isArray(logsData?.toolCalls) && logsData.toolCalls.length > 0) {
        output.toolCalls = logsData.toolCalls as ICallToolCallDTO[];
      }

      if (logsData?.costBreakdown) {
        output.costBreakdown = logsData.costBreakdown;
      }

      // Agent config at time of call
      if (logsData?.voiceConfigUsed || logsData?.slmModelUsed) {
        output.agentConfigAtCallTime = {
          voiceConfig: logsData.voiceConfigUsed ?? null,
          slmModel: logsData.slmModelUsed ?? null,
        };
      }

      // Retry info
      if (logsData?.retryCallId) {
        output.retryCallId = logsData.retryCallId;
      }

      // Full event timeline from ClickHouse (for deep debugging)
      if (Array.isArray(eventsData?.events)) {
        const events = parseEventJsonFields(eventsData.events);
        const summary = summarizeDiagnostics(events);
        if (summary) {
          output.diagnostics = summary.diagnostics;
          output.turnOutcomes = summary.turnOutcomes;
          output.bargeIns = summary.bargeIns;
          output.timelineCompleteness = summary.timelineCompleteness;
        }
        output.eventCount = events.length;
        output.events = events;
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
