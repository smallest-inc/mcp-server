import { createHash } from "node:crypto";

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
  const response = await fetch(`${apiUrl}/account/get-account-details`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

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
    throw new Error(`Failed to verify API key: ${response.status} ${JSON.stringify(data)}`);
  }

  const orgs = data?.organizations;

  if (!orgs || orgs.length === 0) {
    throw new Error("No organizations found for this API key.");
  }

  return {
    orgId: orgs[0].orgId,
    userId: data.userId,
  };
}
