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

/** `sk_` followed by the key body. Masked wherever it appears in an event. */
const API_KEY_PATTERN = /\bsk_[A-Za-z0-9._-]{8,}/g;

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

/** Depth guard: an event with a cycle or a pathological nesting must not hang the reporter. */
const MAX_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[redacted: too deep]";
  if (typeof value === "string") return value.replace(API_KEY_PATTERN, "sk_[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
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
      defaults.filter((i) => !["Http", "Express", "Console", "NodeFetch"].includes(i.name)),
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
