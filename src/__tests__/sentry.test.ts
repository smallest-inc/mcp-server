import { describe, expect, it } from "vitest";

import { redact } from "../sentry.js";

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

  it("does not hang on a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;

    // A cycle would otherwise recurse until the stack gives out, inside the
    // error reporter, while an error is already being handled.
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain("too deep");
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
