import { getAuthenticatedOrg } from "./auth.js";
import { requireContext } from "./context.js";

// TODO: move to the request context alongside apiUrl when the base URLs are
// made configurable — this one is still pinned to prod.
const PAYMENTS_API_URL = "https://api.smallest.ai/payment/v1";

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
  const { apiKey } = requireContext();

  const org = await getAuthenticatedOrg();

  const url = `${PAYMENTS_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Organization-Id": org.orgId,
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
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

export function formatPaymentsApiError(result: PaymentsApiResult): string {
  const msg = result.data?.message ?? result.data?.error ?? JSON.stringify(result.data);
  return `Payments API error ${result.status}: ${msg}`;
}
