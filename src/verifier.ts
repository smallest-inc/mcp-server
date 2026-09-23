import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { consoleConfigFromEnv, validateApiKey, type ConsoleConfig } from "./console-client.js";

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

      const result = await validateApiKey(token, resolved);

      if (!result.ok) {
        if (result.unavailable) {
          // 500, not 401. A console outage must not tell every user their key
          // is invalid — they would rotate keys that were fine.
          throw new ServerError(`Could not verify the API key: ${result.error}`);
        }
        throw new InvalidTokenError(
          "Invalid or revoked API key. Check your key in the Atoms console (Settings > API Keys)."
        );
      }

      return {
        token,
        // No OAuth client exists yet; the key itself identifies the caller.
        clientId: `atoms-api-key:${result.value.organizationId}`,
        scopes: [API_KEY_SCOPE],
        expiresAt: Math.floor(Date.now() / 1000) + VALIDATION_TTL_SECONDS,
        extra: {
          apiKey: token,
          orgId: result.value.organizationId,
          userId: result.value.userId,
        },
      };
    },
  };
}
