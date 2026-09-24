/**
 * Cap on one upstream call. On stdio nothing else bounds it, so a backend that
 * accepts the connection and never answers would hang the tool until the MCP
 * client gives up. The SDK client gives up at 60s, so this stays under that
 * and the caller gets this message instead of a generic client timeout.
 */
export const UPSTREAM_TIMEOUT_MS = 50_000;

export interface UpstreamResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * fetch and read the JSON body for the three API helpers, bounded by
 * UPSTREAM_TIMEOUT_MS and by the request's own signal when there is one
 * (hosted). The body is inside the bound too: a response whose headers arrive
 * and whose body stalls must fail, not read as an empty 200.
 *
 * A plain timer and a listener, both removed on the way out, rather than
 * AbortSignal.timeout / AbortSignal.any: Node keeps an any() signal alive for
 * as long as its sources, and hosted the source is the request's signal, whose
 * abort reason holds the whole response and server. That retained about 1.3 MB
 * per tool call for good.
 */
export async function fetchUpstream(label: string, url: string, init: RequestInit): Promise<UpstreamResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  const requestSignal = init.signal ?? undefined;
  const forwardAbort = () => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) forwardAbort();
  else requestSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // Not JSON (an HTML error page, an empty 204): the status still speaks.
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    // Only our own timer earns this message; a request that ended for its own
    // reason (client gone, deadline) keeps its original error.
    if (timedOut && !requestSignal?.aborted) {
      throw new Error(`${label} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", forwardAbort);
  }
}
