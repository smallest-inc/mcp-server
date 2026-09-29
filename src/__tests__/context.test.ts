import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { atomsApi } from "../api.js";
import { clearOrgCache, getAuthenticatedOrg } from "../auth.js";
import { localContextFromEnv, requireContext, runWithContext, setProcessDefault } from "../context.js";

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
      // Past it, so the org mapping is looked up again.
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

  it.each([
    ["a missing organizations array", { userId: "u" }],
    ["a non-string orgId", { userId: "u", organizations: [{ orgId: {} }] }],
    ["a missing userId", { organizations: [{ orgId: "org-1" }] }],
  ])("treats an unreadable account response as a fault, not a bad key", async (_label, body) => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => body }));

    // A non-string id would coerce to "[object Object]" and ride on every
    // payments call as X-Organization-Id.
    await expect(
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => getAuthenticatedOrg())
    ).rejects.toThrow(/Could not read the account details/);
  });

  it("tells a key with no organizations so, rather than blaming the response", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ userId: "u", organizations: [] }),
    }));

    await expect(
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => getAuthenticatedOrg())
    ).rejects.toThrow("No organizations found for this API key.");
  });

  it("keeps upstream detail out of the error the caller sees", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 502,
      json: async () => ({ message: "upstream atoms-mainbackend.internal:4000 refused" }),
    }));

    // Hosted, this message reaches the client verbatim.
    await expect(
      runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => getAuthenticatedOrg())
    ).rejects.toThrow(/^Failed to verify API key: 502$/);
  });

  it("does not pass an upstream 5xx body back to a caller not marked local", async () => {
    stubFetch();
    const { formatApiError } = await import("../api.js");

    // No flag at all: an entrypoint that forgets to mark its callers must fail
    // closed, since hosted this string reaches a stranger.
    const message = runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
      formatApiError({
        ok: false,
        status: 502,
        data: { message: "connect ECONNREFUSED atoms-mainbackend.internal:4000" },
      })
    );

    expect(message).not.toContain("internal");
    expect(message).toBe("API error 502: the upstream service failed");
  });

  it("keeps the 5xx detail for a stdio caller, who owns the key", async () => {
    const { formatApiError } = await import("../api.js");

    // stderr is invisible in most MCP clients, so this is the only place a
    // local user debugging their own setup would see why the call failed.
    const message = runWithContext(
      { apiKey: "key-a", apiUrl: "https://a.example/atoms/v1", localCaller: true },
      () => formatApiError({ ok: false, status: 503, data: { message: "upstream warming up" } })
    );

    expect(message).toBe("API error 503: upstream warming up");
  });

  it("still passes a 4xx message through, since it is meant for the caller", async () => {
    const { formatApiError } = await import("../api.js");

    expect(
      formatApiError({ ok: false, status: 404, data: { message: "Agent not found" } })
    ).toBe("API error 404: Agent not found");
  });

  it("reads main-backend's real 4xx shape, which carries errors[] and no message", async () => {
    const { formatApiError } = await import("../api.js");

    // getApiErrorResponse in apps/main-backend/src/lib/utils.ts answers
    // { status: false, errors: [...] } — there is no message or error field.
    expect(
      formatApiError({ ok: false, status: 404, data: { status: false, errors: ["Agent not found"] } })
    ).toBe("API error 404: Agent not found");

    expect(
      formatApiError({
        ok: false,
        status: 400,
        data: { status: false, errors: ["name is required", "voiceId is invalid"] },
      })
    ).toBe("API error 400: name is required; voiceId is invalid");
  });

  it("falls back to the raw 4xx body rather than dropping the reason", async () => {
    const { formatApiError } = await import("../api.js");

    // An unrecognised 4xx body is still meant for the caller, so it beats
    // "no detail returned" when an agent has to correct its own request.
    expect(formatApiError({ ok: false, status: 422, data: { detail: "bad field" } })).toBe(
      'API error 422: {"detail":"bad field"}'
    );

    expect(formatApiError({ ok: false, status: 400, data: null })).toBe(
      "API error 400: no detail returned"
    );
  });

  it("formats payment-service's { error, message } shape too", async () => {
    const { formatPaymentsApiError } = await import("../payments-api.js");

    expect(
      formatPaymentsApiError({
        ok: false,
        status: 403,
        data: { error: "API key does not belong to this organization" },
      })
    ).toBe("Payments API error 403: API key does not belong to this organization");
  });

  it("bounds every upstream call, since stdio has no request deadline", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      signals.push(init.signal);
      if (url.includes("/account/get-account-details")) {
        return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "o" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () =>
      atomsApi("GET", "/agent")
    );

    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("names the upstream that timed out instead of a bare abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url.includes("/account/get-account-details")) {
          return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "o" }] }) };
        }
        // Accepts the connection and never answers.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });

      const call = runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => atomsApi("GET", "/agent"));
      const assertion = expect(call).rejects.toThrow("API did not respond within 50s");
      await vi.advanceTimersByTimeAsync(50_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a response whose body stalls, rather than reading it as an empty 200", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url.includes("/account/get-account-details")) {
          return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "o" }] }) };
        }
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        };
      });

      const call = runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => atomsApi("GET", "/agent"));
      const assertion = expect(call).rejects.toThrow("API did not respond within 50s");
      await vi.advanceTimersByTimeAsync(50_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reads a non-JSON body as no data, not as a failure", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/account/get-account-details")) {
        return { ok: true, status: 200, json: async () => ({ userId: "u", organizations: [{ orgId: "o" }] }) };
      }
      return { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    });

    const result = await runWithContext({ apiKey: "key-a", apiUrl: "https://a.example/atoms/v1" }, () => atomsApi("GET", "/agent"));
    expect(result).toEqual({ ok: false, status: 502, data: null });
  });

  it("marks the stdio context as the key owner's own, with the base normalised", () => {
    vi.stubEnv("ATOMS_API_KEY", "key-a");
    vi.stubEnv("ATOMS_API_URL", "https://a.example/atoms/v1/");

    // Without localCaller every npx user would lose the 5xx detail meant for them.
    expect(localContextFromEnv()).toMatchObject({ localCaller: true, apiUrl: "https://a.example/atoms/v1" });
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
