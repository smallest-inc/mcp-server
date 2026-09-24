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
 * Does the error body look like console's own application response rather than
 * a gateway's? Console answers with { success, ... }; an edge rejection does not.
 */
async function hasConsoleShape(response: Response): Promise<boolean> {
  // Only ever called on the !response.ok path, which never reads the body
  // again — a Response body can only be consumed once.
  try {
    const body = await response.json();
    // A boolean specifically. `{success: null}` or `{success: "nope"}` from a
    // gateway would otherwise be read as console's own verdict and blame the
    // caller for what is most likely our service credential.
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { success?: unknown }).success === "boolean"
    );
  } catch {
    return false;
  }
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

  // A 401 or 403 is ambiguous: console rejects a bad USER key and a bad SERVICE
  // key with the same statuses, and the wrong reading is costly in both
  // directions. Answering a rotated service key with "your key is revoked" has
  // every customer rotating a working credential; answering a genuinely revoked
  // key with a 500 leaves them with no idea what to do.
  //
  // The body breaks the tie where it can: console's own handler answers with its
  // application shape ({ success: ... }), while a gateway or middleware
  // rejection does not. Anything we cannot read that way is treated as ours,
  // because that failure mode is recoverable by us and the other is not.
  //
  // TODO: confirm console's actual status and body contract for a revoked user
  // key versus a rejected X-API-Key, and replace this inference with it.
  if (!response.ok) {
    const ambiguous = response.status === 401 || response.status === 403;
    const looksLikeConsoleRejection = ambiguous && (await hasConsoleShape(response));

    if (!looksLikeConsoleRejection) {
      // Distinct event: a spike of these across every organization means our
      // service credential or routing, not a wave of bad customer keys.
      console.error(
        JSON.stringify({ event: "mcp_console_rejected_us", status: response.status })
      );
    }

    return {
      ok: false,
      unavailable: !looksLikeConsoleRejection,
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
