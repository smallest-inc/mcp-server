/**
 * Validates Atoms user API keys against console-backend.
 *
 * The stdio server resolves its single key through main-backend's
 * /account/get-account-details (see auth.ts) using only that key. A hosted
 * server validates a different key on every request, so it goes straight to
 * console instead of paying main-backend as a middleman — the same cutover
 * apps/integrations made. That requires a service credential the stdio server
 * does not have, which is why this is a separate path rather than a
 * replacement.
 */

export interface ValidatedKey {
  organizationId: string;
  userId: string;
}

export type ValidationResult =
  | { ok: true; value: ValidatedKey }
  | { ok: false; unavailable: boolean; error: string };

/** Console must answer quickly — it sits in front of every tool call. */
const CONSOLE_TIMEOUT_MS = 5_000;

export interface ConsoleConfig {
  url: string;
  /** Service credential for console, sent as X-API-Key. Never a user's key. */
  apiKey: string;
}

/**
 * Read at call time rather than at import. Module-level env capture is the bug
 * the request-context refactor removed; reintroducing it here would make this
 * untestable and would freeze config at whatever the process started with.
 */
export function consoleConfigFromEnv(): ConsoleConfig | null {
  const url = process.env.CONSOLE_BACKEND_URL;
  const apiKey = process.env.CONSOLE_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

/**
 * Exchange a user API key for its owning organization.
 *
 * Distinguishes a rejected credential from an unreachable console. Collapsing
 * the two would tell every user their key is invalid during a console outage,
 * and they would rotate perfectly good keys.
 */
export async function validateApiKey(
  apiKey: string,
  config: ConsoleConfig
): Promise<ValidationResult> {
  let response: Response;
  try {
    response = await fetch(`${config.url}/user/token`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
    });
  } catch (error) {
    // No response at all — timeout or outage, not a rejected credential.
    return {
      ok: false,
      unavailable: true,
      error: error instanceof Error ? error.message : "console unreachable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      unavailable: response.status === 429 || response.status >= 500,
      error: `console returned ${response.status}`,
    };
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    return { ok: false, unavailable: true, error: "console returned a non-JSON body" };
  }

  // Console's shape is { success, data: <user>, organizationId } — the key's
  // owning user id is data._id (console user.controller).
  const organizationId = body?.organizationId;
  const userId = body?.data?._id;

  if (!body?.success || !organizationId || !userId) {
    return { ok: false, unavailable: false, error: "console did not resolve the key to an organization" };
  }

  return { ok: true, value: { organizationId: String(organizationId), userId: String(userId) } };
}
