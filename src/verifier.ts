import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createHash } from "node:crypto";

import { consoleConfigFromEnv, validateApiKey, type ConsoleConfig, type ValidatedKey } from "./console-client.js";

/**
 * How long one validation is trusted. Matches the organization cache TTL in
 * auth.ts, and is also the window in which a revoked key keeps working.
 */
export const VALIDATION_TTL_SECONDS = 5 * 60;

/**
 * Scope granted to an API key. Keys are not scoped today — they carry whatever
 * the user can do — so this is a single placeholder that the eventual OAuth
 * work replaces with a real scope model. It exists now so that requiredScopes
 * on the middleware has something to match and the AuthInfo shape does not
 * change when scopes arrive.
 */
export const API_KEY_SCOPE = "atoms:all";

interface CacheEntry {
  value: ValidatedKey;
  expiresAt: number;
}

/**
 * requireBearerAuth calls the verifier on EVERY request, so without this each
 * tool call is a console round trip — an agent firing thirty of them makes
 * thirty, and a slow console stalls all of them. Keyed by a hash of the token,
 * never the token. Failures are never cached.
 */
const validationCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ValidatedKey>>();

const CACHE_MAX_ENTRIES = 1_000;

function cacheKeyFor(token: string, consoleUrl: string): string {
  return createHash("sha256").update(`${token}\u0000${consoleUrl}`).digest("hex");
}

/** Test seam. */
export function clearValidationCache(): void {
  validationCache.clear();
  inFlight.clear();
}

function readCache(key: string): ValidatedKey | null {
  const entry = validationCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    validationCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: ValidatedKey): void {
  const now = Date.now();
  for (const [k, entry] of validationCache) {
    if (entry.expiresAt <= now) validationCache.delete(k);
  }
  while (validationCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = validationCache.keys().next();
    if (oldest.done) break;
    validationCache.delete(oldest.value);
  }
  validationCache.set(key, { value, expiresAt: now + VALIDATION_TTL_SECONDS * 1_000 });
}

/**
 * Verifies an Atoms `sk_` key presented as a bearer token.
 *
 * Note on expiry: requireBearerAuth rejects any AuthInfo whose expiresAt is not
 * a number, with "Token has no expiration time". Atoms API keys do not expire,
 * so we report the lifetime of this *validation* rather than of the key — now
 * plus the TTL above. The middleware re-verifies on every request anyway, so
 * this bounds how stale a cached validation may be, not how long a key lives.
 */
export function createApiKeyVerifier(config?: ConsoleConfig): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const resolved = config ?? consoleConfigFromEnv();
      if (!resolved) {
        // Misconfiguration on our side, not a bad credential from the caller.
        throw new ServerError("Console credentials are not configured");
      }

      const key = cacheKeyFor(token, resolved.url);
      const cached = readCache(key);
      if (cached) return authInfoFor(token, cached);

      const existing = inFlight.get(key);
      if (existing) return authInfoFor(token, await existing);

      const lookup = (async () => {
        const result = await validateApiKey(token, resolved);
        if (!result.ok) {
          if (result.unavailable) {
            // 500, not 401. A console outage must not tell every user their key
            // is invalid — they would rotate keys that were fine. The detail
            // stays in the log: OAuthError.toResponseObject puts `message` into
            // the response body, and result.error can name internal hosts.
            console.error(
              JSON.stringify({ event: "mcp_key_verification_unavailable", error: result.error })
            );
            throw new ServerError("Could not verify the API key right now");
          }
          throw new InvalidTokenError(
            "Invalid or revoked API key. Check your key in the Atoms console (Settings > API Keys)."
          );
        }
        writeCache(key, result.value);
        return result.value;
      })().finally(() => {
        inFlight.delete(key);
      });

      inFlight.set(key, lookup);
      return authInfoFor(token, await lookup);
    },
  };
}

function authInfoFor(token: string, value: ValidatedKey): AuthInfo {
  return {
    token,
    // No OAuth client exists yet; the key itself identifies the caller.
    clientId: `atoms-api-key:${value.organizationId}`,
    scopes: [API_KEY_SCOPE],
    expiresAt: Math.floor(Date.now() / 1000) + VALIDATION_TTL_SECONDS,
    // Deliberately no copy of the key here: AuthInfo.token already carries it,
    // and `extra` is the part most likely to be serialised whole by a logger or
    // error reporter. Consumers read authInfo.token.
    extra: { orgId: value.organizationId, userId: value.userId },
  };
}
