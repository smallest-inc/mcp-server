import * as Sentry from "@sentry/node";

import { optionalContext } from "./context.js";

/**
 * Error reporting for the hosted server. A no-op without SENTRY_DSN, which is
 * how the stdio server and local runs stay silent.
 *
 * The overriding concern here is that every request carries a live Atoms API
 * key in its Authorization header, so the default capture behaviour would ship
 * customer credentials to a third party. Two defences, because either alone is
 * one refactor away from failing: the integrations that capture requests are
 * switched off, and anything key-shaped is masked on the way out.
 */

/**
 * `sk_` followed by the key body, masked wherever it appears.
 *
 * Case-insensitive, and the class includes the characters a base64 or
 * percent-encoded key can carry. A narrower class would stop at the first `+`
 * or `/` and ship the tail of a live credential while looking redacted. The
 * floor is deliberately low: over-masking a string that merely looks like a key
 * costs a little debuggability, under-masking costs a credential.
 */
const API_KEY_PATTERN = /(?<![A-Za-z0-9])sk_[A-Za-z0-9+/=._%-]{4,}/gi;

const REDACTED_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  // One of the header names Claude's static-headers connector option sends.
  "x-auth-token",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "password",
  "secret",
  "cookie",
  "set-cookie",
]);

/**
 * E.164 numbers. make_call and add_audience_members validation errors can echo
 * a callee's number, which is customer data rather than ours to ship.
 */
const PHONE_PATTERN = /\+[1-9]\d{7,14}\b/g;

/** Depth guard, as a backstop to the cycle check below. */
const MAX_DEPTH = 8;

/** Beyond this an event is not worth reporting, and copying it is a liability. */
const MAX_ENTRIES = 5_000;

/**
 * A key in console's minted shape, masked with no lookbehind. The lookbehind
 * above keeps task_list readable, but it also lets a key through when the
 * character before it ends an escape: Bearer%20sk_..., auth%3Dsk_..., or \nsk_...
 * in an already-stringified body. This one runs first.
 */
const EXACT_KEY_PATTERN = /sk_[0-9a-f]{32}/gi;

function maskString(value: string): string {
  return value
    .replace(EXACT_KEY_PATTERN, "sk_[redacted]")
    .replace(API_KEY_PATTERN, "sk_[redacted]")
    .replace(PHONE_PATTERN, "+[redacted]");
}

export function redact(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet(), { count: 0 });
}

function redactInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { count: number }
): unknown {
  if (typeof value === "string") return maskString(value);
  if (typeof value !== "object" || value === null) return value;

  if (depth > MAX_DEPTH) return "[redacted: too deep]";

  // A depth limit alone is not a cycle guard: a self-referencing object with a
  // handful of branches expands to fan-out^depth. Measured at 296 MB for six
  // references and an out-of-memory kill at ten — inside the error reporter,
  // where the try/catch around it cannot help.
  if (seen.has(value)) return "[redacted: circular]";
  if (budget.count++ > MAX_ENTRIES) return "[redacted: too large]";
  seen.add(value);

  try {
    // Types whose useful content is not their enumerable properties. Object
    // .entries on an Error yields nothing, so an Error in `extra` would arrive
    // as {} with its message and stack gone.
    if (value instanceof Error) {
      return {
        name: value.name,
        message: maskString(value.message),
        stack: value.stack ? maskString(value.stack) : undefined,
        cause: value.cause === undefined ? undefined : redactInner(value.cause, depth + 1, seen, budget),
      };
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (ArrayBuffer.isView(value)) return `[binary ${(value as { byteLength: number }).byteLength} bytes]`;
    if (value instanceof Map || value instanceof Set) return `[${value.constructor.name} size ${value.size}]`;

    if (Array.isArray(value)) return value.map((v) => redactInner(v, depth + 1, seen, budget));

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // Property NAMES are masked too: a map keyed by API key — a cache, a
      // per-key counter — would otherwise leak the key wholesale.
      const safeKey = maskString(key);
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        out[safeKey] = "[redacted]";
        continue;
      }
      let inner: unknown;
      try {
        inner = (value as Record<string, unknown>)[key];
      } catch {
        // An enumerable getter that throws would otherwise take the whole event
        // down, and Sentry drops a throwing beforeSend silently.
        out[safeKey] = "[redacted: unreadable]";
        continue;
      }
      out[safeKey] = redactInner(inner, depth + 1, seen, budget);
    }
    return out;
  } catch {
    // Anything hostile that the per-key guard did not cover: a throwing `stack`
    // getter, a Proxy whose ownKeys trap throws, an object impersonating a Map.
    // Sentry drops a throwing beforeSend silently, so without this a single
    // malformed object loses the entire report rather than one field.
    return "[redacted: unreadable]";
  } finally {
    seen.delete(value);
  }
}

export const EXCLUDED_INTEGRATIONS = ["Http", "Express", "Console", "NodeFetch", "OnUnhandledRejection", "McpServer"];

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    // Not NODE_ENV: the image sets it to production in dev too, so dev noise
    // landed in prod alerts. Helm sets this per environment.
    environment: process.env.SENTRY_ENVIRONMENT || "development",
    // The image's git SHA (Dockerfile ARG), so an issue names the build that
    // introduced it. Suspect commits would also need source maps uploaded.
    release: process.env.SENTRY_RELEASE || undefined,
    // SDK 11 replaced sendDefaultPii with this, and its defaults collect
    // headers, bodies, cookies, user info and stack-frame locals (where an
    // apiKey variable lives). Every category is off; the redactor stays as the
    // second line.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // No tracesSampleRate at all: even 0 counts as tracing enabled in SDK 11
    // and installs about 30 tracing integrations, McpServer among them. Traces
    // would need a sampling budget and a collector decision; errors first.
    //
    // Off because the image does not ship @sentry/server-runtime-injection, so
    // every pod start logged a non-JSON "Failed to register diagnostics-channel
    // injection hooks" line; nothing here uses those hooks.
    enableRuntimeChannelInjection: false,
    integrations: (defaults) =>
      // Http/Express/NodeFetch attach request and response detail, including the
      // Authorization header. Console would ship our own structured logs, which
      // already carry org ids.
      //
      // OnUnhandledRejection is removed because Sentry's default for it is
      // warn-and-continue, which silently converts an unhandled rejection from
      // fatal to survivable. http.ts defends the opposite invariant — its
      // close() handlers exist precisely because an unhandled rejection ends the
      // process — and a pod that stays alive in a broken state keeps passing the
      // liveness probe while serving errors.
      //
      // McpServer wraps every MCP server it sees and records tool traffic; it is
      // only installed with tracing, and is listed so it stays out if that changes.
      defaults.filter((i) => !EXCLUDED_INTEGRATIONS.includes(i.name)),
    beforeBreadcrumb: (breadcrumb) => redact(breadcrumb) as typeof breadcrumb,
    beforeSend: (event) => redact(event) as typeof event,
  });
}

/**
 * Tags, not extra: Sentry indexes tags, so "every error for this org" or
 * "every make_call failure" is one filter.
 */
type ErrorTags = Record<string, string | undefined>;

function toTags(tags: ErrorTags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    // Sentry caps tag values at 200 characters.
    if (value) out[key] = maskString(value).slice(0, 200);
  }
  return out;
}

/** Report an error without letting a reporting failure affect the request. */
export function captureError(
  error: unknown,
  tags: ErrorTags = {},
  extra: Record<string, unknown> = {},
  level: "error" | "warning" = "error"
): void {
  try {
    Sentry.captureException(error, {
      level,
      tags: toTags(tags),
      extra: redact(extra) as Record<string, unknown>,
    });
  } catch {
    // Never let the reporter break the thing it is reporting on.
  }
}

const REPORT_INTERVAL_MS = 60_000;

/** Keys seen in the current window; capped so distinct messages can't grow it. */
const lastReport = new Map<string, number>();
const MAX_THROTTLE_KEYS = 1_000;

/**
 * True for the first report of `key` in a minute. During an outage every call
 * fails the same way, and an event per call would spend the Sentry quota
 * exactly when it is needed; one event a minute still shows the outage.
 */
function firstInWindow(key: string): boolean {
  const now = Date.now();
  if (now - (lastReport.get(key) ?? -Infinity) < REPORT_INTERVAL_MS) return false;
  if (lastReport.size >= MAX_THROTTLE_KEYS) {
    for (const [k, at] of lastReport) if (now - at >= REPORT_INTERVAL_MS) lastReport.delete(k);
    if (lastReport.size >= MAX_THROTTLE_KEYS) lastReport.clear();
  }
  lastReport.set(key, now);
  return true;
}

/** Test seam: forget the report throttle. */
export function resetUpstreamReportThrottle(): void {
  lastReport.clear();
}

/**
 * An error thrown inside a tool. Throttled like upstream 5xx: a connection-
 * level outage (ECONNREFUSED, ENOTFOUND, the 50s bound) throws on every call,
 * so the window is keyed by the cause code or message, not by the tool.
 */
export function captureThrownToolError(error: unknown, tool: string): void {
  try {
    const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (!firstInWindow(`thrown:${typeof cause === "string" ? cause : message.slice(0, 120)}`)) return;
    const context = optionalContext();
    captureError(error, { source: "tool", tool, requestId: context?.requestId, orgId: context?.orgId });
  } catch {
    // Same reasoning as captureError.
  }
}

/**
 * An upstream 5xx. Tools return it as text rather than throwing, so without
 * this the most likely production failure never reaches Sentry. Grouped by
 * upstream and status, not by call, so an outage is one issue.
 */
export function captureUpstreamError(upstream: string, status: number): void {
  try {
    if (!firstInWindow(`upstream:${upstream}:${status}`)) return;

    const context = optionalContext();
    Sentry.captureMessage(`${upstream} returned ${status}`, {
      level: "error",
      fingerprint: ["upstream", upstream, String(status)],
      tags: toTags({
        upstream,
        status: String(status),
        requestId: context?.requestId,
        orgId: context?.orgId,
      }),
    });
  } catch {
    // Same reasoning as captureError.
  }
}

/** Flush buffered events on shutdown — a pod dying after a burst is when the buffer is full. */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Same reasoning as captureError.
  }
}
