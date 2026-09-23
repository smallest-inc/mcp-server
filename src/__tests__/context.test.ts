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
