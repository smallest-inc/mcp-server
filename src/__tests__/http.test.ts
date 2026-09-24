import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../http.js";

const realFetch = globalThis.fetch;

let server: Server;
let base: string;
let draining: () => void;

/**
 * Answers console and the Atoms API in-process. Requests to our own test server
 * are passed through to the real fetch, so the app under test is exercised for
 * real rather than mocked.
 */
function stubUpstreams(options: { consoleStatus?: number; delayFor?: string } = {}) {
  const upstream: Array<{ url: string; authorization?: string }> = [];

  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.startsWith(base)) return realFetch(input, init);

    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;

    if (url.includes("console.example/user/token")) {
      const status = options.consoleStatus ?? 200;
      const token = authorization?.replace("Bearer ", "") ?? "unknown";
      return {
        ok: status < 300,
        status,
        json: async () => ({
          success: true,
          // Derive the org from the token so a leaked credential shows up as
          // the wrong org rather than silently passing.
          organizationId: `org-for-${token}`,
          data: { _id: `user-for-${token}` },
        }),
      };
    }

    upstream.push({ url, authorization });

    // Hold one caller's upstream open so the other establishes its context
    // while the first is still mid-flight.
    if (options.delayFor && authorization?.includes(options.delayFor)) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });

  return upstream;
}

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  return realFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const CALL_GET_AGENTS = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "get_agents", arguments: {} },
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

beforeEach(async () => {
  vi.stubEnv("CONSOLE_BACKEND_URL", "https://console.example");
  vi.stubEnv("CONSOLE_API_KEY", "service-key");

  const created = createApp();
  draining = created.startDraining;
  server = await new Promise<Server>((resolve) => {
    const s = created.app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("hosted HTTP transport", () => {
  it("rejects a request with no Authorization header", async () => {
    stubUpstreams();

    const res = await rpc(INITIALIZE);

    expect(res.status).toBe(401);
    // Clients rely on this header to know it is an auth problem rather than a
    // broken endpoint.
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("rejects a key console does not recognise", async () => {
    stubUpstreams({ consoleStatus: 401 });

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_bad" });

    expect(res.status).toBe(401);
  });

  it("does not report a console outage as a bad key", async () => {
    stubUpstreams({ consoleStatus: 503 });

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_live" });

    // 500, not 401 — otherwise every user is told to rotate a working key.
    expect(res.status).toBe(500);
  });

  it("initializes for a valid key", async () => {
    stubUpstreams();

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_live" });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('"serverInfo"');
    expect(body).toContain('"smallest"');
  });

  it("runs a tool, and sends the caller's own key upstream", async () => {
    const upstream = stubUpstreams();

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live" });
    expect(res.status).toBe(200);

    // The previous version of this test only sent `initialize`, which touches
    // no context, no tool and no upstream — it passed with runWithContext
    // deleted. This one fails if the context is not established.
    expect(upstream.length).toBeGreaterThan(0);
    for (const call of upstream) {
      expect(call.authorization).toBe("Bearer sk_live");
    }
  });

  it("keeps two concurrent callers' credentials apart", async () => {
    const upstream = stubUpstreams({ delayFor: "sk_AAA" });

    await Promise.all([
      rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_AAA" }),
      rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_BBB" }),
    ]);

    // The whole reason the credentials moved out of module scope.
    const keys = new Set(upstream.map((c) => c.authorization));
    expect(keys).toEqual(new Set(["Bearer sk_AAA", "Bearer sk_BBB"]));
    expect(upstream.filter((c) => c.authorization === "Bearer sk_AAA").length).toBeGreaterThan(0);
    expect(upstream.filter((c) => c.authorization === "Bearer sk_BBB").length).toBeGreaterThan(0);
  });

  it("answers a malformed body in JSON-RPC, without a stack trace", async () => {
    stubUpstreams();

    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer sk_live",
      },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe(-32700);
    // The express default handler used to return HTML with absolute server paths.
    expect(body).not.toMatch(/node_modules|SyntaxError|at /);
  });

  it("does not let an unauthenticated caller reach the body parser", async () => {
    stubUpstreams();

    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    // Auth runs first, so a malformed body from a stranger is a 401 and the pod
    // never buffers it.
    expect(res.status).toBe(401);
  });

  it("answers GET and DELETE with 405 rather than leaving them to 404", async () => {
    stubUpstreams();

    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const res = await realFetch(`${base}/mcp`, { method });
      expect(res.status).toBe(405);
      // RFC 9110 makes Allow mandatory on a 405.
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("fails readiness while draining so the load balancer stops sending traffic", async () => {
    expect((await realFetch(`${base}/health/ready`)).status).toBe(200);
    expect((await realFetch(`${base}/health/live`)).status).toBe(200);

    draining();

    expect((await realFetch(`${base}/health/ready`)).status).toBe(503);
    // Liveness must stay up, or Kubernetes restarts the pod mid-drain.
    expect((await realFetch(`${base}/health/live`)).status).toBe(200);
  });
});
