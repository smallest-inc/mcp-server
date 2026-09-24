import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureError, initSentry, redact } from "../sentry.js";

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
    await Sentry.close(0);
    vi.unstubAllEnvs();
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
    captureError(new Error(`upstream rejected ${key}`), {
      headers: { Authorization: `Bearer ${key}` },
      nested: [{ url: `https://x/y?token=${key}` }],
    });
    await Sentry.flush(2_000);

    expect(envelopes.length).toBeGreaterThan(0);
    const wire = envelopes.join("");
    expect(wire).not.toContain(key);
    expect(wire).toContain("sk_[redacted]");

    (client as any)._transport = original;
  });
});
