import { getAuthenticatedOrg } from "./auth.js";
import { requireContext } from "./context.js";
import { describeUpstreamError } from "./upstream-error.js";
import { fetchUpstream } from "./upstream-fetch.js";

interface PaymentsApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Make an authenticated request to the Payments API.
 * Automatically includes the API key and X-Organization-Id header.
 */
export async function paymentsApi(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  path: string,
  body?: unknown
): Promise<PaymentsApiResult> {
  const { apiKey, paymentsUrl } = requireContext("for payment API calls");

  const org = await getAuthenticatedOrg();

  const url = `${paymentsUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Organization-Id": org.orgId,
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return fetchUpstream("Payments API", url, init);
}

export function formatPaymentsApiError(result: PaymentsApiResult): string {
  return describeUpstreamError("Payments API", result.status, result.data);
}
