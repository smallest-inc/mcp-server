import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleConfig } from "../console-client.js";
import { API_KEY_SCOPE, createApiKeyVerifier } from "../verifier.js";

const CONFIG: ConsoleConfig = { url: "https://console.example", apiKey: "service-key" };

function stubConsole(response: { status?: number; body?: unknown } | { reject: Error }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API key verifier", () => {
  it("resolves a valid key to an AuthInfo carrying the org", async () => {
    const calls = stubConsole({ body: OK_BODY });

    const auth = await createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live");

    expect(auth.extra).toMatchObject({ apiKey: "sk_live", orgId: "org-1", userId: "user-1" });
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
    stubConsole({ status: 401 });

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

  it("treats a success body with no organization as a bad key", async () => {
    stubConsole({ body: { success: true, data: { _id: "user-1" } } });

    await expect(createApiKeyVerifier(CONFIG).verifyAccessToken("sk_live")).rejects.toBeInstanceOf(
      InvalidTokenError
    );
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
