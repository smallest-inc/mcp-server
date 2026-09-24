import { createHash } from "node:crypto";

import { z } from "zod";

import { requireContext } from "./context.js";

interface AuthenticatedOrg {
  orgId: string;
  userId: string;
}

interface CacheEntry {
  org: AuthenticatedOrg;
  expiresAt: number;
}

/**
 * How long a resolved organization is trusted. This is also the window in which
 * a revoked key keeps working, so it stays short.
 */
const ORG_CACHE_TTL_MS = 5 * 60 * 1000;

/** Bound on distinct keys held at once, so a hosted process can't grow unbounded. */
const ORG_CACHE_MAX_ENTRIES = 1_000;

/**
 * Hard cap on the account lookup.
 *
 * Without it a backend that accepts the connection and never answers wedges the
 * key permanently: the in-flight promise below never settles, so every later
 * caller presenting that key coalesces onto the same hang and nothing clears it
 * short of a restart. Coalescing turns one slow request into a per-tenant
 * deadlock unless the lookup is bounded.
 */
const ACCOUNT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Keyed by a hash of the API key, never the key itself — a heap dump or a log
 * of this map must not hand out credentials. One entry per caller, because a
 * single shared entry (what this replaces) would serve one tenant's
 * organization to another tenant's request.
 */
const orgCache = new Map<string, CacheEntry>();

/**
 * Includes the API base, not just the key. One key resolves to different
 * organizations against different backends, and the context now carries a
 * per-caller apiUrl — so keying on the key alone could serve a dev org to a
 * prod request. NUL separates the fields so they cannot be confused for one
 * another by concatenation.
 */
function cacheKeyFor(apiKey: string, apiUrl: string): string {
  return createHash("sha256").update(`${apiKey}\u0000${apiUrl}`).digest("hex");
}

function readCache(key: string): AuthenticatedOrg | null {
  const entry = orgCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    orgCache.delete(key);
    return null;
  }
  return entry.org;
}

function writeCache(key: string, org: AuthenticatedOrg): void {
  // Drop anything already expired before considering the size bound, so a burst
  // of one-off keys doesn't evict live entries that simply haven't been re-read.
  const now = Date.now();
  for (const [k, entry] of orgCache) {
    if (entry.expiresAt <= now) orgCache.delete(k);
  }

  // Map iterates in insertion order, so the first key is the oldest write.
  while (orgCache.size >= ORG_CACHE_MAX_ENTRIES) {
    const oldest = orgCache.keys().next();
    if (oldest.done) break;
    orgCache.delete(oldest.value);
  }

  orgCache.set(key, { org, expiresAt: now + ORG_CACHE_TTL_MS });
}

/**
 * Lookups already in flight, so a burst of concurrent first-use requests for
 * one key makes one call to the account endpoint rather than one per request.
 * Entries are removed as soon as they settle; failures are never cached.
 */
const inFlight = new Map<string, Promise<AuthenticatedOrg>>();

/**
 * Fields must be present and non-empty. Truthiness alone would let an object or
 * a number through String() as "[object Object]" or "1234" and cache it as a
 * real organization — which then rides on every payments call as
 * X-Organization-Id. Same reasoning as the console client's parser.
 */
const AccountResponse = z.object({
  userId: z.string().min(1),
  organizations: z.array(z.object({ orgId: z.string().min(1) })).min(1),
});

/** Test seam: drop all cached organizations and in-flight lookups. */
export function clearOrgCache(): void {
  orgCache.clear();
  inFlight.clear();
}

/**
 * Resolves the calling context's API key to an organization.
 *
 * Calls the atoms-main-backend account endpoint, which validates the API key
 * via the console service and returns the user's org info.
 *
 * Uses fetch directly instead of atomsApi to avoid a circular dependency
 * (atomsApi calls getAuthenticatedOrg, which would call atomsApi again).
 */
export async function getAuthenticatedOrg(): Promise<AuthenticatedOrg> {
  const { apiKey, apiUrl } = requireContext();

  const key = cacheKeyFor(apiKey, apiUrl);
  const cached = readCache(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const lookup = resolveOrg(apiKey, apiUrl)
    .then((org) => {
      writeCache(key, org);
      return org;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, lookup);
  return lookup;
}

async function resolveOrg(apiKey: string, apiUrl: string): Promise<AuthenticatedOrg> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/account/get-account-details`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(ACCOUNT_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    // Detail to the log, not to the caller: in a hosted process this message
    // reaches the client and the fetch error names internal hosts.
    console.error(
      JSON.stringify({
        event: "atoms_account_lookup_unreachable",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new Error("Could not reach the Atoms API to verify the API key");
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Invalid or revoked ATOMS_API_KEY. " +
          "Check your API key in the Atoms console (Settings > API Keys)."
      );
    }
    console.error(
      JSON.stringify({
        event: "atoms_account_lookup_failed",
        status: response.status,
        body: JSON.stringify(data)?.slice(0, 500),
      })
    );
    throw new Error(`Failed to verify API key: ${response.status}`);
  }

  const parsed = AccountResponse.safeParse(data);
  if (!parsed.success) {
    // A 200 we cannot read is an infrastructure fault, not a verdict on the
    // key — the same distinction the console client draws. Saying "no
    // organizations" here would send users off rotating a working credential
    // because main-backend changed a field type.
    console.error(
      JSON.stringify({
        event: "atoms_account_lookup_unreadable",
        issues: parsed.error.issues.map((i) => i.path.join(".")).join(","),
      })
    );
    throw new Error("Could not read the account details response");
  }

  return {
    orgId: parsed.data.organizations[0].orgId,
    userId: parsed.data.userId,
  };
}
