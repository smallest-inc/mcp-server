import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomsApi } from "../api.js";
import { clearOrgCache, getAuthenticatedOrg } from "../auth.js";
import { requireContext, runWithContext, setProcessDefault } from "../context.js";

interface Captured {
  url: string;
  authorization: string | undefined;
}

/**
 * Stubs fetch and records every request. Account lookups answer with an org
 * derived from the bearer token, so a leaked credential shows up as the wrong
 * orgId rather than as a silent pass.
 */
function stubFetch(): Captured[] {
  const captured: Captured[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string>)?.Authorization;
    captured.push({ url, authorization });

    if (url.includes("/account/get-account-details")) {
      const key = authorization?.replace("Bearer ", "") ?? "unknown";
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: `user-for-${key}`, organizations: [{ orgId: `org-for-${key}` }] }),
      };
    }

    return { ok: true, status: 200, json: async () => ({ data: "ok" }) };
  });

  return captured;
}

beforeEach(() => {
  clearOrgCache();
  setProcessDefault(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearOrgCache();
  setProcessDefault(null);
});

describe("request-scoped credentials", () => {
  it("keeps concurrent callers' keys and orgs separate", async () => {
    const captured = stubFetch();

    const [orgA, orgB] = await Promise.all([
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, async () => {
        await atomsApi("GET", "/agent");
        return getAuthenticatedOrg();
      }),
      runWithContext({ apiKey: "key-b", apiUrl: "https://b.example/atoms/v1" }, async () => {
        await atomsApi("GET", "/agent");
        return getAuthenticatedOrg();
      }),
    ]);

    // The whole point of the refactor: neither caller sees the other's identity.
    expect(orgA.orgId).toBe("org-for-key-a");
    expect(orgB.orgId).toBe("org-for-key-b");

    const agentCalls = captured.filter((c) => c.url.endsWith("/agent"));
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls.find((c) => c.url.startsWith("https://a.example"))?.authorization).toBe("Bearer key-a");
    expect(agentCalls.find((c) => c.url.startsWith("https://b.example"))?.authorization).toBe("Bearer key-b");
  });

  it("caches the org per key, not per process", async () => {
    const captured = stubFetch();

    const run = (apiKey: string) =>
      runWithContext({ apiKey, apiUrl: "https://a.example/atoms/v1" }, () => getAuthenticatedOrg());

    await run("key-a");
    await run("key-a");
    const orgB = await run("key-b");

    const accountCalls = captured.filter((c) => c.url.includes("/account/get-account-details"));
    // key-a resolved once and was served from cache the second time; key-b had
    // to resolve on its own rather than inheriting the cached entry.
    expect(accountCalls).toHaveLength(2);
    expect(orgB.orgId).toBe("org-for-key-b");
  });

  it("falls back to the process default when no context is in scope", async () => {
    const captured = stubFetch();
    setProcessDefault({ apiKey: "env-key", apiUrl: "https://env.example/atoms/v1" });

    await atomsApi("GET", "/agent");

    expect(captured.find((c) => c.url.endsWith("/agent"))?.authorization).toBe("Bearer env-key");
  });

  it("stops trusting a resolved org once the TTL passes", async () => {
    vi.useFakeTimers();
    try {
      const captured = stubFetch();
      const resolve = () =>
        runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
          getAuthenticatedOrg()
        );

      await resolve();
      vi.advanceTimersByTime(4 * 60 * 1000);
      await resolve();
      // Still inside the 5 minute TTL — served from cache.
      expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(1);

      vi.advanceTimersByTime(2 * 60 * 1000);
      await resolve();
      // Past it. This is the window in which a revoked key keeps working, so it
      // has to actually expire.
      expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves one org per key even when many callers arrive at once", async () => {
    const captured = stubFetch();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
          getAuthenticatedOrg()
        )
      )
    );

    expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(1);
  });

  it("keeps the same key apart across different API bases", async () => {
    const captured = stubFetch();

    const dev = await runWithContext(
      { apiKey: "same-key", apiUrl: "https://dev.example/atoms/v1" },
      () => getAuthenticatedOrg()
    );
    const prod = await runWithContext(
      { apiKey: "same-key", apiUrl: "https://prod.example/atoms/v1" },
      () => getAuthenticatedOrg()
    );

    // One key can name different orgs on different backends, so a cache keyed
    // on the key alone would serve the dev org to the prod caller.
    expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(2);
    expect(dev.orgId).toBe("org-for-same-key");
    expect(prod.orgId).toBe("org-for-same-key");
  });

  it("never caches a failed lookup, and lets the next caller retry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
      return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "org-1" }] }) };
    });

    const run = () =>
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
        getAuthenticatedOrg()
      );

    await expect(run()).rejects.toThrow(/Failed to verify API key/);
    // A failure must not poison the cache, nor leave the in-flight entry behind.
    await expect(run()).resolves.toMatchObject({ orgId: "org-1" });
    expect(calls).toBe(2);
  });

  it("bounds the account lookup so a hung backend cannot wedge a key", async () => {
    // A hung lookup used to be shared by every later caller for that key and
    // never cleared, so one slow backend deadlocked the tenant until restart.
    // The abort is simulated rather than waited out; what matters is that a
    // signal is attached and that an abort surfaces as a clean rejection.
    const signals: Array<AbortSignal | undefined | null> = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      calls += 1;
      if (calls === 1) throw new DOMException("The operation was aborted", "TimeoutError");
      return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "org-1" }] }) };
    });

    const run = () =>
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
        getAuthenticatedOrg()
      );

    await expect(run()).rejects.toThrow(/Could not reach the Atoms API/);
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    // The hung attempt left nothing behind, so the next caller gets through.
    await expect(run()).resolves.toMatchObject({ orgId: "org-1" });
  });

  it("evicts the oldest entry rather than growing without bound", async () => {
    stubFetch();

    // One more than the 1000-entry bound.
    for (let i = 0; i < 1001; i += 1) {
      await runWithContext({ apiKey: `key-${i}`, apiUrl: "https://a.example/atoms/v1" }, () =>
        getAuthenticatedOrg()
      );
    }

    const captured = stubFetch();
    // key-0 was evicted, so it resolves again; the most recent key is still cached.
    await runWithContext({ apiKey: "key-1000", apiUrl: "https://a.example/atoms/v1" }, () =>
      getAuthenticatedOrg()
    );
    expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(0);

    await runWithContext({ apiKey: "key-0", apiUrl: "https://a.example/atoms/v1" }, () =>
      getAuthenticatedOrg()
    );
    expect(captured.filter((c) => c.url.includes("/account/"))).toHaveLength(1);
  });

  it("throws when nothing established a context", () => {
    expect(() => requireContext()).toThrow(/ATOMS_API_KEY/);
  });

  it("does not let a process default leak into an explicit context", async () => {
    const captured = stubFetch();
    setProcessDefault({ apiKey: "env-key", apiUrl: "https://env.example/atoms/v1" });

    await runWithContext({ apiKey: "req-key", apiUrl: "https://req.example/atoms/v1" }, () =>
      atomsApi("GET", "/agent")
    );

    const agentCall = captured.find((c) => c.url.endsWith("/agent"));
    expect(agentCall?.authorization).toBe("Bearer req-key");
    expect(agentCall?.url).toBe("https://req.example/atoms/v1/agent");
  });
});
