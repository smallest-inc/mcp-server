import { basesFromEnv, optionalContext, requireContext } from "./context.js";
import { describeUpstreamError } from "./upstream-error.js";
import { fetchUpstream } from "./upstream-fetch.js";

interface WavesApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Make a request to the Waves API, against the base in the caller's context.
 * Auth is optional — some endpoints (like voice listing) are public.
 */
export async function wavesApi(
  method: "GET" | "POST",
  path: string,
  options?: { auth?: boolean; body?: unknown }
): Promise<WavesApiResult> {
  // Some endpoints here are public (voice listing), so the base URL is read
  // without demanding a credential — requiring one unconditionally would break
  // get_voices for anyone who has not configured a key yet.
  const url = `${optionalContext()?.wavesUrl ?? basesFromEnv().wavesUrl}${path}`;
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

  return fetchUpstream("Waves API", url, init);
}

export function formatWavesApiError(result: WavesApiResult): string {
  return describeUpstreamError("Waves API", result.status, result.data);
}
