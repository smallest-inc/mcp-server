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

import { z } from "zod";

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
  serviceApiKey: string;
}

/**
 * Fields are required and must be non-empty strings. Truthiness alone is not
 * enough: an object or array here would coerce to something like
 * "[object Object]" and silently collapse distinct tenants onto one identity.
 */
const ConsoleUserResponse = z.object({
  success: z.boolean(),
  organizationId: z.string().min(1),
  data: z.object({ _id: z.string().min(1) }),
});

/**
 * Read at call time rather than at import. Module-level env capture is the bug
 * the request-context refactor removed; reintroducing it here would make this
 * untestable and would freeze config at whatever the process started with.
 */
export function consoleConfigFromEnv(): ConsoleConfig | null {
  const url = process.env.CONSOLE_BACKEND_URL;
  const serviceApiKey = process.env.CONSOLE_API_KEY;
  if (!url || !serviceApiKey) return null;
  return { url: url.replace(/\/+$/, ""), serviceApiKey };
}

/**
 * Exchange a user API key for its owning organization.
 *
 * Distinguishes a rejected credential from an unreachable console. Collapsing
 * the two would tell every user their key is invalid during a console outage,
 * and they would rotate perfectly good keys.
 */
export async function validateApiKey(
  userApiKey: string,
  config: ConsoleConfig
): Promise<ValidationResult> {
  const base = config.url.replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetch(`${base}/user/token`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        // The service credential identifies us to console; the bearer token is
        // the caller's. Distinct names on purpose — swapping them would present
        // the service key as a user token, which console might well resolve.
        "X-API-Key": config.serviceApiKey,
        Authorization: `Bearer ${userApiKey}`,
      },
      // Never follow a redirect. Authorization is dropped cross-origin but
      // custom headers are not, so a 302 would replay the shared service key to
      // whatever host console points at.
      redirect: "manual",
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

  // Only a 401 is console telling us the caller's key is bad. A 403 or 404 is
  // far more likely to be OUR problem — a rotated service key, a wrong
  // CONSOLE_BACKEND_URL, a stale route — and answering those with "your key is
  // revoked" would have every user rotating perfectly good keys during an
  // outage. A 3xx lands here too, since redirects are not followed.
  if (!response.ok) {
    return {
      ok: false,
      unavailable: response.status !== 401,
      error: `console returned ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, unavailable: true, error: "console returned a non-JSON body" };
  }

  // Console's shape is { success, data: <user>, organizationId } — the key's
  // owning user id is data._id (console user.controller). A 200 we cannot parse
  // into that shape is an infrastructure fault, not a credential decision, so
  // it must not surface as "your key is invalid".
  const parsed = ConsoleUserResponse.safeParse(body);
  if (!parsed.success) {
    return { ok: false, unavailable: true, error: "console returned an unrecognised body" };
  }

  if (!parsed.data.success) {
    return { ok: false, unavailable: false, error: "console did not accept the key" };
  }

  return {
    ok: true,
    value: { organizationId: parsed.data.organizationId, userId: parsed.data.data._id },
  };
}
