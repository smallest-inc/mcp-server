/**
 * Cap on one upstream call. On stdio nothing else bounds it, so a backend that
 * accepts the connection and never answers would hang the tool until the MCP
 * client gives up. The SDK client gives up at 60s, so this stays under that
 * and the caller gets this message instead of a generic client timeout.
 */
export const UPSTREAM_TIMEOUT_MS = 50_000;

/** fetch for the three API helpers, bounded by UPSTREAM_TIMEOUT_MS. */
export async function fetchUpstream(label: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`${label} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
}
