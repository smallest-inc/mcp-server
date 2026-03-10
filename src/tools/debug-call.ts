import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

function computeLatencySummary(events: unknown[]): Record<string, unknown> | null {
  // Look for turn_latency_analysis events or extract latency from turn events
  const latencies: number[] = [];

  for (const event of events) {
    const ev = event as Record<string, unknown>;
    // Check for explicit latency events
    if (ev.type === "turn_latency_analysis" || ev.eventType === "turn_latency_analysis") {
      const latency = ev.latencyMs ?? ev.latency_ms ?? ev.latency;
      if (typeof latency === "number") {
        latencies.push(latency);
      }
    }
    // Also check for latency data nested in event data
    if (ev.data && typeof ev.data === "object") {
      const data = ev.data as Record<string, unknown>;
      if (typeof data.latencyMs === "number") {
        latencies.push(data.latencyMs);
      } else if (typeof data.latency_ms === "number") {
        latencies.push(data.latency_ms);
      }
    }
  }

  if (latencies.length === 0) return null;

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);

  return {
    turn_count: sorted.length,
    avg_ms: Math.round(avg),
    median_ms: Math.round(median),
    p95_ms: Math.round(sorted[p95Index]),
    min_ms: Math.round(sorted[0]),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

export function registerDebugCall(server: McpServer) {
  server.registerTool(
    "debug_call",
    {
      description:
        "Deep-dive into a single call for debugging. Returns full transcript, errors, timing, cost breakdown, latency summary (avg/median/p95), post-call analytics, and agent config at time of call. Use a callId (e.g. CALL-1234567890-abc123).",
      inputSchema: {
        call_id: z.string().describe("The callId to debug (e.g. CALL-1234567890-abc123)"),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/analytics/conversation-details/${encodeURIComponent(params.call_id)}`
      );

      if (!result.ok) {
        if (result.status === 404) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Call not found: ${params.call_id}. Make sure you're using the full callId (e.g. CALL-1234567890-abc123).`,
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      // Extract latency summary from events if available
      const events = data?.events ?? data?.rawEvents ?? [];
      const latencySummary = Array.isArray(events) ? computeLatencySummary(events) : null;

      const output = latencySummary
        ? { ...data, latency_summary: latencySummary }
        : data;

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
