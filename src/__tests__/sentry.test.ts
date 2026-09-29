import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithContext } from "../context.js";
import {
  EXCLUDED_INTEGRATIONS,
  captureError,
  captureThrownToolError,
  captureUpstreamError,
  initSentry,
  redact,
  resetUpstreamReportThrottle,
} from "../sentry.js";
import { describeUpstreamError, onUpstreamError } from "../upstream-error.js";

describe("Sentry redaction", () => {
  it("masks an API key wherever it appears in a string", () => {
    const out = redact("failed for Bearer sk_live_abcdef123456 on /agent");
    expect(out).toBe("failed for Bearer sk_[redacted] on /agent");
  });

  it("drops credential-bearing headers whatever their casing", () => {
    const out = redact({
      request: {
        headers: { Authorization: "Bearer sk_live_abcdef123456", "X-API-Key": "svc", accept: "*/*" },
      },
    }) as any;

    expect(out.request.headers.Authorization).toBe("[redacted]");
    expect(out.request.headers["X-API-Key"]).toBe("[redacted]");
    // Anything not a credential is left alone, or the reports are useless.
    expect(out.request.headers.accept).toBe("*/*");
  });

  it("reaches keys nested inside arrays and objects", () => {
    const out = redact({
      breadcrumbs: [{ data: { url: "https://x/y?k=sk_live_abcdef123456" } }],
    }) as any;

    expect(out.breadcrumbs[0].data.url).toBe("https://x/y?k=sk_[redacted]");
  });

  it("does not blow up on a cycle with many references", () => {
    // A depth limit alone is not a cycle guard: with N self-references the
    // output is N^depth. The previous single-reference fixture passed while
    // six references produced 296 MB and ten killed the process.
    const cyclic: Record<string, unknown> = { name: "a" };
    for (let i = 0; i < 10; i += 1) cyclic[`ref${i}`] = cyclic;

    const out = JSON.stringify(redact(cyclic));
    expect(out).toContain("circular");
    expect(out.length).toBeLessThan(10_000);
  });

  it("masks a key used as a property name", () => {
    const out = redact({ "sk_live_a1b2c3d4e5f6": { hits: 3 } }) as Record<string, unknown>;

    // A cache or counter keyed by API key would otherwise leak it wholesale.
    expect(Object.keys(out)).toEqual(["sk_[redacted]"]);
  });

  it.each([
    ["an uppercase prefix", "SK_LIVE_A1B2C3D4E5F6"],
    ["base64 characters", "sk_live_ab+cd/ef=ghij"],
    ["percent encoding", "sk_live_ab%2Bcd%2Fef12345"],
    ["a short body", "sk_AAA1"],
  ])("masks a key with %s", (_label, key) => {
    // A narrower class stopped at the first + or / and shipped the tail of a
    // live credential while looking redacted.
    expect(redact(`Bearer ${key}`)).not.toContain(key);
  });

  it.each([
    ["an Error whose stack getter throws", () => {
      const e = new Error("boom");
      Object.defineProperty(e, "stack", { get() { throw new Error("nope"); } });
      return e;
    }],
    ["an object impersonating a Map", () => Object.create(Map.prototype)],
    ["a Proxy whose ownKeys trap throws", () => new Proxy({}, { ownKeys() { throw new Error("nope"); } })],
  ])("does not lose the whole report to %s", (_label, make) => {
    // Sentry drops a throwing beforeSend silently, so one hostile object used
    // to take every field with it.
    const out = redact({ hostile: make(), keep: "visible" }) as any;
    expect(out.keep).toBe("visible");
    expect(out.hostile).toBe("[redacted: unreadable]");
  });

  it("keeps an Error readable instead of flattening it to {}", () => {
    const err = new Error("failed for sk_live_a1b2c3d4e5f6");
    const out = redact({ err }) as any;

    // Object.entries on an Error yields nothing, so it used to arrive as {}
    // with the message and stack gone — in the only reporting path there is.
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe("failed for sk_[redacted]");
    expect(out.err.stack).toContain("sk_[redacted]");
  });

  it("survives a getter that throws", () => {
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
      fine: "ok",
    };

    // Sentry drops a throwing beforeSend silently, so this would lose the whole
    // report rather than one field.
    const out = redact(hostile) as any;
    expect(out.boom).toBe("[redacted: unreadable]");
    expect(out.fine).toBe("ok");
  });

  it("drops the credential fields OAuth and connector headers use", () => {
    const out = redact({
      "Proxy-Authorization": "Basic abc",
      "X-Auth-Token": "t",
      client_secret: "s",
      refresh_token: "r",
      id_token: "i",
      password: "p",
      secret: "x",
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) expect(value).toBe("[redacted]");
  });

  it("masks a real key even right after an escape sequence", () => {
    const key = "sk_0123456789abcdef0123456789abcdef";
    // The character before sk_ is alphanumeric in each of these, which the
    // looser pattern's lookbehind lets through.
    for (const text of [`Bearer%20${key}`, `auth%3D${key}`, `{"msg":"line\\n${key}"}`]) {
      expect(redact(text)).not.toContain(key);
    }
  });

  it("leaves identifiers that merely contain sk_ alone", () => {
    expect(redact("task_list and disk_usage")).toBe("task_list and disk_usage");
    expect(redact("key=sk_live_abcdef123456")).toBe("key=sk_[redacted]");
  });

  it("masks E.164 phone numbers, which upstream validation errors can echo", () => {
    expect(redact("invalid callee +919876543210 for agent a1")).toBe("invalid callee +[redacted] for agent a1");
    // A bare number with no + is not E.164 and is left alone (ids, timestamps).
    expect(redact("took 1727600000123 ms")).toBe("took 1727600000123 ms");
  });

  it("leaves ordinary values untouched", () => {
    expect(redact({ n: 1, b: true, s: "hello", nil: null })).toEqual({
      n: 1,
      b: true,
      s: "hello",
      nil: null,
    });
  });
});

describe("Sentry end to end", () => {
  afterEach(async () => {
    resetUpstreamReportThrottle();
    await Sentry.close(0);
    vi.unstubAllEnvs();
  });

  it("does not install the integrations that would leak requests or swallow rejections", async () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    const client = Sentry.getClient();

    // OnUnhandledRejection defaults to warn-and-continue, which silently
    // contradicts the invariant http.ts defends with its close() handlers.
    for (const name of EXCLUDED_INTEGRATIONS) {
      expect(client?.getIntegrationByName(name), `${name} should be filtered out`).toBeUndefined();
    }
    // Not vacuous: the names must still exist in the SDK's defaults, or a rename
    // in an SDK upgrade would let the integration back in while this passes.
    const defaults = Sentry.getDefaultIntegrations({}).map((i) => i.name);
    for (const name of EXCLUDED_INTEGRATIONS.filter((n) => n !== "McpServer")) {
      expect(defaults, `${name} is no longer a default integration name`).toContain(name);
    }
    // Tracing stays off, which is what keeps McpServer and the rest out.
    expect(client?.getOptions().tracesSampleRate).toBeUndefined();
    // Not asserting listenerCount here: the test runner registers its own
    // unhandledRejection handler, so the integration set is the real signal.
  });

  it("never lets an API key reach the transport", async () => {
    const envelopes: string[] = [];

    // The redactor is tested directly above; this asserts the wiring actually
    // applies it, which is the property that matters.
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    Sentry.getClient()?.getOptions();

    const client = Sentry.getClient();
    expect(client, "initSentry should have created a client").toBeTruthy();

    // Intercept what would go over the wire.
    const original = (client as any).getTransport();
    (client as any)._transport = {
      send: async (envelope: unknown) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    };

    const key = "sk_live_a1b2c3d4e5f6g7h8";
    captureError(
      new Error(`upstream rejected ${key}`),
      { requestId: "req-1" },
      {
        headers: { Authorization: `Bearer ${key}` },
        nested: [{ url: `https://x/y?token=${key}` }],
      }
    );
    await Sentry.flush(2_000);

    expect(envelopes.length).toBeGreaterThan(0);
    const wire = envelopes.join("");
    expect(wire).not.toContain(key);
    expect(wire).toContain("sk_[redacted]");

    (client as any)._transport = original;
  });

  function interceptTransport(): string[] {
    const envelopes: string[] = [];
    (Sentry.getClient() as any)._transport = {
      send: async (envelope: unknown) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    };
    return envelopes;
  }

  it("tags the environment from SENTRY_ENVIRONMENT, not NODE_ENV", () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    // The image sets NODE_ENV=production in dev too.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SENTRY_ENVIRONMENT", "development");
    vi.stubEnv("SENTRY_RELEASE", "abc1234");
    initSentry();

    const options = Sentry.getClient()?.getOptions();
    expect(options?.environment).toBe("development");
    expect(options?.release).toBe("abc1234");
    expect(options?.dataCollection).toMatchObject({ httpHeaders: false, httpBodies: [], stackFrameVariables: false });
  });

  it("sends request, org and tool as tags, which Sentry indexes", async () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    const envelopes = interceptTransport();

    captureError(new Error("boom"), { requestId: "req-9", orgId: "org-9", tool: "make_call" });
    await Sentry.flush(2_000);

    const wire = envelopes.join("");
    expect(wire).toMatch(/"tags":\{[^}]*"requestId":"req-9"/);
    expect(wire).toContain('"orgId":"org-9"');
    expect(wire).toContain('"tool":"make_call"');
  });

  it("sends at most one event a minute per upstream and status during an outage", async () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    const envelopes = interceptTransport();

    for (let i = 0; i < 5; i += 1) captureUpstreamError("API", 502);
    captureUpstreamError("API", 503);
    await Sentry.flush(2_000);

    const events = envelopes.filter((e) => e.includes('"fingerprint"'));
    expect(events.filter((e) => e.includes('"502"'))).toHaveLength(1);
    expect(events.filter((e) => e.includes('"503"'))).toHaveLength(1);
  });

  it("throttles a connection-level outage that throws on every call", async () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    const envelopes = interceptTransport();

    const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    captureThrownToolError(refused(), "get_credit_balance");
    captureThrownToolError(refused(), "get_invoices");
    captureThrownToolError(refused(), "get_plans");
    captureThrownToolError(new TypeError("x is not a function"), "get_agents");
    await Sentry.flush(2_000);

    const events = envelopes.filter((e) => e.includes('"type":"event"'));
    // One for the outage, whichever tool hit it, and one for the unrelated bug.
    expect(events).toHaveLength(2);
  });

  it("groups upstream 5xx by upstream and status, with the caller's ids", async () => {
    vi.stubEnv("SENTRY_DSN", "https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry();
    const envelopes = interceptTransport();

    runWithContext(
      { apiKey: "k", apiUrl: "a", wavesUrl: "w", paymentsUrl: "p", requestId: "req-5", orgId: "org-5" },
      () => captureUpstreamError("Payments API", 502)
    );
    await Sentry.flush(2_000);

    const wire = envelopes.join("");
    expect(wire).toContain('"fingerprint":["upstream","Payments API","502"]');
    expect(wire).toContain('"requestId":"req-5"');
  });
});

describe("upstream error hook", () => {
  afterEach(() => {
    onUpstreamError(null);
    vi.restoreAllMocks();
  });

  it("reports a hosted 5xx and nothing else", () => {
    const reported: Array<[string, number]> = [];
    onUpstreamError((upstream, status) => reported.push([upstream, status]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const hosted = { apiKey: "k", apiUrl: "a", wavesUrl: "w", paymentsUrl: "p" };
    runWithContext(hosted, () => describeUpstreamError("API", 503, null));
    runWithContext(hosted, () => describeUpstreamError("API", 404, null));
    // stdio's key owner sees the detail; there is no Sentry there.
    runWithContext({ ...hosted, localCaller: true }, () => describeUpstreamError("API", 500, null));

    expect(reported).toEqual([["API", 503]]);
  });

  it("never lets a failing reporter change the caller's answer", () => {
    onUpstreamError(() => {
      throw new Error("reporter down");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const message = runWithContext({ apiKey: "k", apiUrl: "a", wavesUrl: "w", paymentsUrl: "p" }, () =>
      describeUpstreamError("API", 502, null)
    );
    expect(message).toBe("API error 502: the upstream service failed");
  });
});
