import { isHosted } from "./context.js";

type UpstreamErrorReporter = (upstream: string, status: number) => void;

let reportUpstreamError: UpstreamErrorReporter | null = null;

/**
 * The hosted entrypoint plugs Sentry in here. This module is in the stdio
 * bundle, which leaves npm packages external and does not ship @sentry/node,
 * so importing the SDK here would break every npx install.
 */
export function onUpstreamError(reporter: UpstreamErrorReporter | null): void {
  reportUpstreamError = reporter;
}

/**
 * Turn an upstream failure into something safe to hand the caller.
 *
 * A 4xx is the API telling the caller what they did wrong, so its own message
 * is the useful thing to pass on. A 5xx is our side failing, and its body
 * routinely names internal hosts and ports — hosted, that string goes straight
 * to a stranger, so it gets a generic line with the detail in the log. On stdio
 * the caller is the key owner and stderr is invisible in most MCP clients, so
 * they keep the upstream detail.
 *
 * The upstreams don't agree on a body shape: main-backend answers
 * `{ status: false, errors: ["Agent not found"] }`, payment-service answers
 * `{ error, message }`. Handle every shape here so the three callers can't
 * drift apart.
 */
export function describeUpstreamError(label: string, status: number, data: unknown): string {
  if (status >= 500) {
    if (!isHosted()) {
      return `${label} error ${status}: ${extractDetail(data)}`;
    }
    console.error(
      JSON.stringify({
        event: "upstream_error",
        upstream: label,
        status,
        body: JSON.stringify(data)?.slice(0, 500),
      })
    );
    try {
      reportUpstreamError?.(label, status);
    } catch {
      // Reporting must never change what the caller gets back.
    }
    return `${label} error ${status}: the upstream service failed`;
  }

  return `${label} error ${status}: ${extractDetail(data)}`;
}

function extractDetail(data: unknown): string {
  const body = data as
    | { errors?: unknown; message?: unknown; error?: unknown }
    | null
    | undefined;

  // main-backend's getApiErrorResponse: { status: false, errors: string[] }
  if (Array.isArray(body?.errors)) {
    const joined = body.errors.filter((e): e is string => typeof e === "string").join("; ");
    if (joined) return joined;
  }

  if (typeof body?.message === "string" && body.message) return body.message;
  if (typeof body?.error === "string" && body.error) return body.error;

  // A 4xx body is meant for the caller, so an unrecognised shape is still
  // more use to them than "no detail returned".
  if (data !== null && data !== undefined) {
    const serialized = JSON.stringify(data);
    if (serialized && serialized !== "{}" && serialized !== "null") {
      return serialized.slice(0, 300);
    }
  }

  return "no detail returned";
}
