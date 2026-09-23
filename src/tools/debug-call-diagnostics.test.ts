import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEventJsonFields, summarizeDiagnostics } from "./debug-call-diagnostics.js";

const RUNTIME = "atoms-orchestrator";

function callEnd(diagnostics: Record<string, unknown> | undefined) {
  return {
    eventType: "call_end",
    source: RUNTIME,
    metadata: JSON.stringify({ call_status: "completed", ...(diagnostics ? { diagnostics } : {}) }),
  };
}

test("parses JSON text columns and leaves other text alone", () => {
  const [row] = parseEventJsonFields([
    { eventType: "metrics", metrics: '{"ttfb":0.12}', metadata: "not json", context: "" },
  ]);
  assert.deepEqual(row.metrics, { ttfb: 0.12 });
  assert.equal(row.metadata, "not json");
  assert.equal(row.context, "");
});

test("returns null for a call without diagnostic records", () => {
  const events = parseEventJsonFields([
    { eventType: "call_start", source: RUNTIME },
    callEnd(undefined),
  ]);
  assert.equal(summarizeDiagnostics(events), null);
});

test("collects diagnostics, ordered turn outcomes and barge-ins", () => {
  const events = parseEventJsonFields([
    { eventType: "turn_outcome", source: RUNTIME, metadata: '{"turn_index":2,"attempt":1,"outcome":"no_reply"}' },
    { eventType: "turn_outcome", source: RUNTIME, metadata: '{"turn_index":1,"attempt":2,"outcome":"replied"}' },
    { eventType: "turn_outcome", source: RUNTIME, metadata: '{"turn_index":1,"attempt":1,"outcome":"interrupted"}' },
    { eventType: "barge_in", source: RUNTIME, metadata: '{"barge_in_seq":2,"hold_outcome":"refused"}' },
    { eventType: "barge_in", source: RUNTIME, metadata: '{"barge_in_seq":1,"hold_outcome":"accepted"}' },
    callEnd({ schema: 1, counts: { events_emitted: 5 } }),
  ]);

  const summary = summarizeDiagnostics(events);
  assert.ok(summary);
  assert.deepEqual(summary.diagnostics, { schema: 1, counts: { events_emitted: 5 } });
  assert.deepEqual(
    summary.turnOutcomes.map((t) => [t.turn_index, t.attempt]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
    ]
  );
  assert.deepEqual(
    summary.bargeIns.map((b) => b.barge_in_seq),
    [1, 2]
  );
  assert.deepEqual(summary.timelineCompleteness, { emitted: 5, stored: 5, complete: true });
});

test("flags a timeline with fewer stored runtime events than emitted", () => {
  const events = parseEventJsonFields([
    { eventType: "call_queued", source: "dispatcher" },
    { eventType: "user_transcription", source: RUNTIME },
    callEnd({ schema: 1, counts: { events_emitted: 9 } }),
  ]);
  const summary = summarizeDiagnostics(events);
  assert.deepEqual(summary?.timelineCompleteness, { emitted: 9, stored: 1, complete: false });
});

test("reports unknown completeness when the runtime did not count its events", () => {
  const events = parseEventJsonFields([callEnd({ schema: 1 })]);
  assert.deepEqual(summarizeDiagnostics(events)?.timelineCompleteness, {
    emitted: null,
    stored: 0,
    complete: null,
  });
});
