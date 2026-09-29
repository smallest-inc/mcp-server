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
 * fetch and read the JSON body for the three API helpers, both bounded by
 * UPSTREAM_TIMEOUT_MS. The body is inside the bound too: a response whose
 * headers arrive and whose body stalls must fail, not read as an empty 200.
 *
 * A plain timer rather than AbortSignal.timeout, cleared on the way out, so
 * nothing about the call outlives it.
 */
export async function fetchUpstream(label: string, url: string, init: RequestInit): Promise<UpstreamResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

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
    if (timedOut) {
      throw new Error(`${label} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
