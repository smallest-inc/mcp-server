import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleConfig } from "../console-client.js";
import { API_KEY_SCOPE, clearValidationCache, createApiKeyVerifier } from "../verifier.js";

const CONFIG: ConsoleConfig = { url: "https://console.example", serviceApiKey: "service-key" };

function stubConsole(response: { status?: number; body?: unknown } | { reject: Error }) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
    if ("reject" in response) throw response.reject;
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
    };
  });

  return calls;
}

const OK_BODY = { success: true, organizationId: "org-1", data: { _id: "user-1" } };

beforeEach(() => clearValidationCache());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearValidationCache();
});

describe("API key verifier", () => {
  it("resolves a valid key to an AuthInfo carrying the org", async () => {
    const calls = stubConsole({ body: OK_BODY });

    const auth = await createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live");

    expect(auth.token).toBe("sk_live");
    expect(auth.extra).toEqual({ orgId: "org-1", userId: "user-1" });
    // The key must not be duplicated into `extra`, which loggers serialise whole.
    expect(JSON.stringify(auth.extra)).not.toContain("sk_live");
    expect(auth.scopes).toEqual([API_KEY_SCOPE]);
    expect(calls[0].url).toBe("https://console.example/user/token");
    // The user's key authenticates the user; the service key authenticates us.
    expect(calls[0].headers.Authorization).toBe("Bearer sk_live");
    expect(calls[0].headers["X-API-Key"]).toBe("service-key");
  });

  it("always sets a numeric future expiresAt", async () => {
    stubConsole({ body: OK_BODY });

    const auth = await createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live");

    // requireBearerAuth rejects AuthInfo without one ("Token has no expiration
    // time"), so an omitted expiresAt would 401 every request with a valid key.
    expect(typeof auth.expiresAt).toBe("number");
    expect(auth.expiresAt!).toBeGreaterThan(Date.now() / 1000);
  });

  it("rejects a bad key as an invalid token", async () => {
    stubConsole({ status: 401, body: { success: false, error: "invalid key" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_bad")).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it.each([
    ["a console 500", { status: 500 } as const],
    ["a console 429", { status: 429 } as const],
    ["an unreachable console", { reject: new Error("timeout") }],
  ])("reports %s as a server error, not a bad key", async (_label, response) => {
    stubConsole(response as any);

    const verify = createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live");

    // The distinction that matters: a 401 here would tell every user their key
    // is invalid during an outage, and they would rotate keys that were fine.
    await expect(verify).rejects.toBeInstanceOf(ServerError);
    await expect(verify).rejects.not.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects the key only when console explicitly says so", async () => {
    stubConsole({ body: { success: false, organizationId: "org-1", data: { _id: "user-1" } } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it.each([
    ["a 403 with no console body, most likely our own service key", { status: 403 } as const],
    ["a 404 from a wrong CONSOLE_BACKEND_URL", { status: 404 } as const],
    ["a 400", { status: 400 } as const],
    ["a 302, since redirects are not followed", { status: 302 } as const],
  ])("does not blame the caller's key for %s", async (_label, response) => {
    stubConsole(response as any);

    // Answering these with 401 would have every user rotating a working key
    // because someone rotated the service credential or moved a route.
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it.each([
    ["a null body", null],
    ["a body missing organizationId", { success: true, data: { _id: "user-1" } }],
    ["a non-string organizationId", { success: true, organizationId: {}, data: { _id: "u" } }],
    ["an empty organizationId", { success: true, organizationId: "", data: { _id: "u" } }],
    ["a body missing the user id", { success: true, organizationId: "org-1", data: {} }],
  ])("treats %s as an infrastructure fault, not a bad key", async (_label, body) => {
    stubConsole({ body });

    // A non-string id would coerce to something like "[object Object]" and
    // collapse distinct tenants onto one identity, so it must fail closed.
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it("validates once for repeated requests with the same key", async () => {
    const calls = stubConsole({ body: OK_BODY });
    const verifier = createApiKeyVerifier(CONFIG);

    await verifier.verifyAccessToken("sk_live");
    await verifier.verifyAccessToken("sk_live");
    await Promise.all([verifier.verifyAccessToken("sk_live"), verifier.verifyAccessToken("sk_live")]);

    // requireBearerAuth runs the verifier on every request, so without a cache
    // every tool call is a console round trip.
    expect(calls).toHaveLength(1);
  });

  it("does not cache a rejection", async () => {
    stubConsole({ status: 401, body: { success: false } });
    const verifier = createApiKeyVerifier(CONFIG);
    await expect(verifier.verifyAccessToken("sk_live")).rejects.toBeInstanceOf(InvalidTokenError);

    const calls = stubConsole({ body: OK_BODY });
    await expect(verifier.verifyAccessToken("sk_live")).resolves.toMatchObject({ token: "sk_live" });
    expect(calls).toHaveLength(1);
  });

  it("treats a 401 without console's body shape as our problem, not the caller's", async () => {
    // A gateway or middleware rejecting OUR service key answers 401 too. Reading
    // that as a revoked customer key is the outage this whole path exists to
    // avoid, so the body has to break the tie.
    stubConsole({ status: 401, body: { message: "invalid api key" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it.each([
    ["a null success field", { success: null }],
    ["a string success field", { success: "nope" }],
    ["an array body", ["nope"]],
  ])("does not read %s as console's own verdict", async (_label, body) => {
    stubConsole({ status: 401, body });

    // Only console answers with a boolean `success`. Anything else at 401 is
    // most likely our service credential, and blaming the caller for that is
    // the outage this whole path exists to avoid.
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it("does not follow redirects, and does not leak the service key in errors", async () => {
    const calls = stubConsole({ status: 500 });

    const error = await createApiKeyVerifier(CONFIG)
      .verifyAccessToken("sk_live")
      .then(() => new Error("expected a rejection"), (e) => e as Error);

    // The message reaches the client verbatim via error_description, so assert
    // the exact string — a substring match would pass with a hostname appended.
    expect(error.message).toBe("Could not verify the API key right now");
    expect(calls[0].redirect).toBe("manual");
  });

  it("fails as a server error when console credentials are unset, without calling out", async () => {
    vi.stubEnv("CONSOLE_BACKEND_URL", "");
    vi.stubEnv("CONSOLE_API_KEY", "");
    const calls = stubConsole({ body: OK_BODY });

    // No config argument, so it falls back to the environment and finds nothing.
    await expect(createApiKeyVerifier().verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      ServerError
    );
    expect(calls).toHaveLength(0);
  });
});
