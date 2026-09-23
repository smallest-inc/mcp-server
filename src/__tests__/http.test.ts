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
function stubUpstreams(options: { consoleStatus?: number } = {}) {
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.startsWith(base)) return realFetch(input, init);

    if (url.includes("console.example/user/token")) {
      const status = options.consoleStatus ?? 200;
      return {
        ok: status < 300,
        status,
        json: async () => ({ success: true, organizationId: "org-1", data: { _id: "user-1" } }),
      };
    }

    // Any Atoms/Waves/payments call a tool might make.
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
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

  it("initializes and lists tools for a valid key", async () => {
    stubUpstreams();

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_live" });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('"serverInfo"');
    expect(body).toContain('"smallest"');
  });

  it("answers GET and DELETE with 405 rather than leaving them to 404", async () => {
    stubUpstreams();

    for (const method of ["GET", "DELETE"]) {
      const res = await realFetch(`${base}/mcp`, { method });
      expect(res.status).toBe(405);
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
