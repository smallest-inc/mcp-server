import { getAuthenticatedOrg } from "./auth.js";
import { requireContext } from "./context.js";
import { describeUpstreamError } from "./upstream-error.js";
import { fetchUpstream } from "./upstream-fetch.js";

interface ApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Make an authenticated request to the Atoms main-backend API.
 * Automatically includes the API key and resolves the org context.
 */
export async function atomsApi(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<ApiResult> {
  const { apiKey, apiUrl , signal } = requireContext();

  // Ensure org is resolved (validates the API key on first call)
  await getAuthenticatedOrg();

  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };

  const init: RequestInit = { method, headers, signal };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return fetchUpstream("API", url, init);
}

export function formatApiError(result: ApiResult): string {
  return describeUpstreamError("API", result.status, result.data);
}
