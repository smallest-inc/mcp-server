/**
 * Turn an upstream failure into something safe to hand the caller.
 *
 * A 4xx is the API telling the caller what they did wrong, so its own message
 * is the useful thing to pass on. A 5xx is our side failing, and its body
 * routinely names internal hosts and ports — hosted, that string goes straight
 * to a stranger. Those get a generic line, with the detail in the log.
 *
 * The upstreams don't agree on a body shape: main-backend answers
 * `{ status: false, errors: ["Agent not found"] }`, payment-service answers
 * `{ error, message }`. Handle every shape here so the three callers can't
 * drift apart.
 */
export function describeUpstreamError(label: string, status: number, data: unknown): string {
  if (status >= 500) {
    console.error(
      JSON.stringify({
        event: "upstream_error",
        upstream: label,
        status,
        body: JSON.stringify(data)?.slice(0, 500),
      })
    );
    return `${label} error ${status}: the upstream service failed`;
  }

  return `${label} error ${status}: ${extract4xxDetail(data)}`;
}

function extract4xxDetail(data: unknown): string {
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
