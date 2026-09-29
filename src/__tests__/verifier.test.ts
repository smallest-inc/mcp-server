import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleConfig } from "../console-client.js";
import {
  AccountBlockedError,
  API_KEY_SCOPE,
  clearValidationCache,
  createApiKeyVerifier,
} from "../verifier.js";

const CONFIG: ConsoleConfig = { url: "https://console.example", serviceApiKey: "service-key" };

function stubConsole(response: { status?: number; body?: unknown } | { reject: Error }) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  let bodiesRead = 0;
  (stubConsole as { bodiesRead?: () => number }).bodiesRead = () => bodiesRead;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
    if ("reject" in response) throw response.reject;
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        bodiesRead += 1;
        return response.body;
      },
    };
  });

  return calls;
}

const OK_BODY = { success: true, organizationId: "org-1", data: { _id: "user-1" } };

const KEY = "sk_0123456789abcdef0123456789abcdef";

beforeEach(() => clearValidationCache());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearValidationCache();
});

describe("API key verifier", () => {
  it("resolves a valid key to an AuthInfo carrying the org", async () => {
    const calls = stubConsole({ body: OK_BODY });

    const auth = await createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef");

    expect(auth.token).toBe("sk_0123456789abcdef0123456789abcdef");
    expect(auth.extra).toEqual({ orgId: "org-1", userId: "user-1" });
    // The key must not be duplicated into `extra`, which loggers serialise whole.
    expect(JSON.stringify(auth.extra)).not.toContain("sk_0123456789abcdef0123456789abcdef");
    expect(auth.scopes).toEqual([API_KEY_SCOPE]);
    expect(calls[0].url).toBe("https://console.example/user/token");
    // The user's key authenticates the user; the service key authenticates us.
    expect(calls[0].headers.Authorization).toBe("Bearer sk_0123456789abcdef0123456789abcdef");
    expect(calls[0].headers["X-API-Key"]).toBe("service-key");
  });

  it("always sets a numeric future expiresAt", async () => {
    stubConsole({ body: OK_BODY });

    const auth = await createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef");

    // requireBearerAuth rejects AuthInfo without one ("Token has no expiration
    // time"), so an omitted expiresAt would 401 every request with a valid key.
    expect(typeof auth.expiresAt).toBe("number");
    expect(auth.expiresAt!).toBeGreaterThan(Date.now() / 1000);
  });

  it("rejects a bad key as an invalid token", async () => {
    stubConsole({ status: 401, body: { success: false, error: "invalid key" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_fedcba9876543210fedcba9876543210")).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it.each([
    ["a console 500", { status: 500 } as const],
    ["a console 429", { status: 429 } as const],
    ["an unreachable console", { reject: new Error("timeout") }],
  ])("reports %s as a server error, not a bad key", async (_label, response) => {
    stubConsole(response as any);

    const verify = createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef");

    // The distinction that matters: a 401 here would tell every user their key
    // is invalid during an outage, and they would rotate keys that were fine.
    await expect(verify).rejects.toBeInstanceOf(ServerError);
    await expect(verify).rejects.not.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects the key only when console explicitly says so", async () => {
    stubConsole({ body: { success: false, organizationId: "org-1", data: { _id: "user-1" } } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
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
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
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
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it("consumes the response body even when it does not need to read it", async () => {
    stubConsole({ status: 500, body: { message: "boom" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
      ServerError
    );

    // undici holds the connection until the body is consumed, so skipping it on
    // a 500 accumulates sockets during exactly the outage producing them.
    expect((stubConsole as { bodiesRead?: () => number }).bodiesRead?.()).toBe(1);
  });

  it("validates once for repeated requests with the same key", async () => {
    const calls = stubConsole({ body: OK_BODY });
    const verifier = createApiKeyVerifier(CONFIG);

    await verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef");
    await verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef");
    await Promise.all([verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef"), verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef")]);

    // requireBearerAuth runs the verifier on every request, so without a cache
    // every tool call is a console round trip.
    expect(calls).toHaveLength(1);
  });

  it("does not cache a rejection", async () => {
    stubConsole({ status: 401, body: { success: false } });
    const verifier = createApiKeyVerifier(CONFIG);
    await expect(verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(InvalidTokenError);

    const calls = stubConsole({ body: OK_BODY });
    await expect(verifier.verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).resolves.toMatchObject({ token: "sk_0123456789abcdef0123456789abcdef" });
    expect(calls).toHaveLength(1);
  });

  it("treats a 401 without console's body shape as our problem, not the caller's", async () => {
    // A gateway or middleware rejecting OUR service key answers 401 too. Reading
    // that as a revoked customer key is the outage this whole path exists to
    // avoid, so the body has to break the tie.
    stubConsole({ status: 401, body: { message: "invalid api key" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
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
    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it("does not follow redirects, and does not leak the service key in errors", async () => {
    const calls = stubConsole({ status: 500 });

    const error = await createApiKeyVerifier(CONFIG)
      .verifyAccessToken("sk_0123456789abcdef0123456789abcdef")
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
    await expect(createApiKeyVerifier().verifyAccessToken("sk_0123456789abcdef0123456789abcdef")).rejects.toBeInstanceOf(
      ServerError
    );
    expect(calls).toHaveLength(0);
  });
  it("tells a blocked account it is blocked, not that its key is bad", async () => {
    // Console's block gate on /user/token (console-backend user.controller.ts).
    // The wire value of ACCOUNT_BLOCKED_ERROR_TYPE is "account-blocked".
    stubConsole({
      status: 403,
      body: {
        success: false,
        error: "Your account has been blocked.",
        error_type: "account-blocked",
        message: "Your account has been blocked.",
      },
    });

    const error = await createApiKeyVerifier(CONFIG)
      .verifyAccessToken(KEY)
      .catch((e: unknown) => e);

    // A distinct 403 — rotating the key would not help, so it must not read
    // as InvalidTokenError's "check your key".
    expect(error).toBeInstanceOf(AccountBlockedError);
    expect(error).not.toBeInstanceOf(InvalidTokenError);
    expect((error as AccountBlockedError).toResponseObject()).toMatchObject({
      error: "account_blocked",
      error_description: "Your account has been blocked.",
    });
  });

  it("keeps console's block message safe to put in a header", async () => {
    stubConsole({
      status: 403,
      body: {
        success: false,
        error_type: "account-blocked",
        message: 'Blocked "for review"\r\nSet-Cookie: x=1 ' + "a".repeat(300),
      },
    });

    const error = await createApiKeyVerifier(CONFIG)
      .verifyAccessToken(KEY)
      .catch((e: unknown) => e);

    // requireBearerAuth quotes this into WWW-Authenticate; a newline there
    // makes Node throw and the 403 becomes a 500.
    const description = (error as AccountBlockedError).toResponseObject().error_description ?? "";
    expect(description).not.toMatch(/["\r\n]/);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(() => new Headers({ "WWW-Authenticate": `Bearer error_description="${description}"` })).not.toThrow();
  });

  it("still reads a console 403 without the block marker as a rejected key", async () => {
    stubConsole({ status: 403, body: { success: false, error: "Forbidden" } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken(KEY)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it("rejects a token that cannot be an API key without calling console", async () => {
    const calls = stubConsole({ body: OK_BODY });
    const verifier = createApiKeyVerifier(CONFIG);

    for (const token of ["hello", "Bearer sk_x", "sk_", "sk_short", "sk_" + "a".repeat(200), "sk_abc$%^&*()abcdefghijk"]) {
      await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
    }

    // The point: garbage tokens don't turn this endpoint into a console load generator.
    expect(calls).toHaveLength(0);
  });
});
