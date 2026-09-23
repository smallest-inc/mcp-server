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

export function formatWavesApiError(result: WavesApiResult): string {
  const msg = result.data?.message ?? result.data?.error ?? JSON.stringify(result.data);
  return `Waves API error ${result.status}: ${msg}`;
}
