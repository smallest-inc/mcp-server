import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerDebugCall(server: McpServer) {
  server.registerTool(
    "debug_call",
    {
      description:
        "Deep-dive into a single call for debugging. Returns call status, failure reasons, errors, transcript, post-call analytics, latency metrics, cost breakdown, variables, voice/model config at time of call, and full event timeline. Use a callId (e.g. CALL-1234567890-abc123).",
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

      // Latency metrics (pre-computed from MongoDB, more reliable than recalculating)
      if (logsData?.turnLatencyMetrics) {
        output.turnLatencyMetrics = logsData.turnLatencyMetrics;
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
      if (eventsData?.events) {
        output.eventCount = eventsData.events.length;
        output.events = eventsData.events;
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
