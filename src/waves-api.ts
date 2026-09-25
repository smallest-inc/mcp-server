import { requireContext } from "./context.js";

// TODO: move to the request context alongside apiUrl when the base URLs are
// made configurable — this one is still pinned to prod.
const WAVES_API_URL = "https://api.smallest.ai/waves/v1";

interface WavesApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Make a request to the Waves API.
 * WAVES_API_URL is the full base URL (e.g. "https://waves-api.smallest.ai/api/v1").
 * Auth is optional — some endpoints (like voice listing) are public.
 */
export async function wavesApi(
  method: "GET" | "POST",
  path: string,
  options?: { auth?: boolean; body?: unknown }
): Promise<WavesApiResult> {
  const url = `${WAVES_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options?.auth) {
    headers.Authorization = `Bearer ${requireContext("for authenticated Waves API calls").apiKey}`;
  }

  const init: RequestInit = { method, headers };
  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}

/**
 * Turn an upstream failure into something safe to hand the caller.
 *
 * A 4xx is the API telling the caller what they did wrong, so its own message
 * is the useful thing to pass on. A 5xx is our side failing, and its body
 * routinely names internal hosts and ports — hosted, that string goes straight
 * to a stranger. Those get a generic line, with the detail in the log.
 */
function describeUpstreamError(label: string, status: number, data: unknown): string {
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

  const body = data as { message?: unknown; error?: unknown } | null | undefined;
  const message =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : "no detail returned";
  return `${label} error ${status}: ${message}`;
}

export function formatWavesApiError(result: WavesApiResult): string {
  return describeUpstreamError("Waves API", result.status, result.data);
}
