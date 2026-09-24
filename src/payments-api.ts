import { getAuthenticatedOrg } from "./auth.js";
import { requireContext } from "./context.js";

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
  const { apiKey, paymentsUrl , signal } = requireContext("for payment API calls");

  const org = await getAuthenticatedOrg();

  const url = `${paymentsUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Organization-Id": org.orgId,
  };

  const init: RequestInit = { method, headers, signal };
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

export function formatPaymentsApiError(result: PaymentsApiResult): string {
  return describeUpstreamError("Payments API", result.status, result.data);
}
