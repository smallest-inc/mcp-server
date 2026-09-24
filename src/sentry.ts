import * as Sentry from "@sentry/node";

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
const API_KEY_PATTERN = /sk_[A-Za-z0-9+/=._%-]{4,}/gi;

const REDACTED_KEYS = new Set([
  "authorization",
  "x-api-key",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "cookie",
  "set-cookie",
]);

/** Depth guard, as a backstop to the cycle check below. */
const MAX_DEPTH = 8;

/** Beyond this an event is not worth reporting, and copying it is a liability. */
const MAX_ENTRIES = 5_000;

function maskString(value: string): string {
  return value.replace(API_KEY_PATTERN, "sk_[redacted]");
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
  } finally {
    seen.delete(value);
  }
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Traces would need a sampling budget and a collector decision; errors first.
    tracesSampleRate: 0,
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
      defaults.filter(
        (i) =>
          !["Http", "Express", "Console", "NodeFetch", "OnUnhandledRejection"].includes(i.name)
      ),
    beforeBreadcrumb: (breadcrumb) => redact(breadcrumb) as typeof breadcrumb,
    beforeSend: (event) => redact(event) as typeof event,
  });
}

/** Report an error without letting a reporting failure affect the request. */
export function captureError(error: unknown, context: Record<string, unknown> = {}): void {
  try {
    Sentry.captureException(error, { extra: redact(context) as Record<string, unknown> });
  } catch {
    // Never let the reporter break the thing it is reporting on.
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
