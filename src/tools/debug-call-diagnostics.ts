type EventRow = Record<string, unknown>;

// Relay columns that carry JSON text. Parsed so the timeline reads as data, not escaped strings.
const JSON_TEXT_FIELDS = ["metadata", "metrics", "context"] as const;

export interface TimelineCompleteness {
  /** CT-2 events the runtime handed to the bus for this call, excluding call_end. */
  emitted: number | null;
  /** Of those, how many are in the timeline. */
  stored: number | null;
  /** False means events were lost between the runtime and the analytics store. */
  complete: boolean | null;
}

export interface CallDiagnosticsSummary {
  /** call_end metadata.diagnostics: build, endpoints, effective settings, setup, recording, media. */
  diagnostics: Record<string, unknown> | null;
  /** One entry per turn attempt, including turns where the agent never spoke. */
  turnOutcomes: Record<string, unknown>[];
  /** One entry per barge-in candidate. */
  bargeIns: Record<string, unknown>[];
  timelineCompleteness: TimelineCompleteness | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventTypeOf(event: EventRow): string | undefined {
  const value = event.eventType ?? event.event_type;
  return typeof value === "string" ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseEventJsonFields(events: EventRow[]): EventRow[] {
  return events.map((event) => {
    const parsed: EventRow = { ...event };
    for (const field of JSON_TEXT_FIELDS) {
      const value = event[field];
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        parsed[field] = JSON.parse(value);
      } catch {
        // Not JSON: keep the raw text.
      }
    }
    return parsed;
  });
}

function metadataOf(event: EventRow): Record<string, unknown> | null {
  const metadata = event.metadata;
  if (isObject(metadata)) return metadata;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sortBy(rows: Record<string, unknown>[], keys: string[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const left = numberOrNull(a[key]) ?? Number.MAX_SAFE_INTEGER;
      const right = numberOrNull(b[key]) ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
    }
    return 0;
  });
}

function completenessOf(
  events: EventRow[],
  callEnd: EventRow | undefined,
  diagnostics: Record<string, unknown> | null
): TimelineCompleteness | null {
  if (!callEnd || !diagnostics) return null;
  const counts = isObject(diagnostics.counts) ? diagnostics.counts : null;
  const emitted = numberOrNull(counts?.events_emitted);
  // The runtime stamps its own `source` on every event it sends, so the call_end's source
  // identifies the runtime's rows among the platform's lifecycle and post-call rows.
  const source = callEnd.source;
  const stored =
    typeof source === "string" && source.length > 0
      ? events.filter((event) => event !== callEnd && event.source === source).length
      : null;
  const complete = emitted === null || stored === null ? null : stored >= emitted;
  return { emitted, stored, complete };
}

/**
 * Pulls the runtime's diagnostic records out of a call's event timeline. Returns null when the
 * call carries none of them, so older calls keep the tool's previous output shape.
 */
export function summarizeDiagnostics(events: EventRow[]): CallDiagnosticsSummary | null {
  const callEnd = events.find((event) => eventTypeOf(event) === "call_end");
  const callEndMetadata = callEnd ? metadataOf(callEnd) : null;
  const diagnostics = isObject(callEndMetadata?.diagnostics) ? callEndMetadata.diagnostics : null;

  const turnOutcomes = sortBy(
    events
      .filter((event) => eventTypeOf(event) === "turn_outcome")
      .map(metadataOf)
      .filter(isObject),
    ["turn_index", "attempt"]
  );
  const bargeIns = sortBy(
    events
      .filter((event) => eventTypeOf(event) === "barge_in")
      .map(metadataOf)
      .filter(isObject),
    ["barge_in_seq"]
  );

  if (!diagnostics && turnOutcomes.length === 0 && bargeIns.length === 0) return null;

  return {
    diagnostics,
    turnOutcomes,
    bargeIns,
    timelineCompleteness: completenessOf(events, callEnd, diagnostics),
  };
}
