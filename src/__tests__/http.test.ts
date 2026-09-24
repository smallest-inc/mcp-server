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

    // Delay the FIRST of the tool's two sequential calls, so the second one
    // reads the context after the other caller has established its own.
    if (options.delayFor && url.includes("/agent/") && authorization?.includes(options.delayFor)) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    // The account lookup is validated strictly, so it needs a real shape.
    if (url.includes("/account/get-account-details")) {
      const token = authorization?.replace("Bearer ", "") ?? "unknown";
      upstream.push({ url, authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: `user-${token}`, organizations: [{ orgId: `org-${token}` }] }),
      };
    }

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

/**
 * get_agent_prompt makes two SEQUENTIAL upstream calls. atomsApi reads the
 * context at the top of each call, so delaying the first means the second
 * reads it again after the other caller has established its own — which is
 * what makes a last-writer-wins context observable. A tool with a single call,
 * or two parallel ones, reads the context before any interleaving can happen
 * and would pass even with no isolation at all.
 */
const CALL_GET_AGENT_PROMPT = {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "get_agent_prompt", arguments: { agent_id: "agent-1" } },
};

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

    // Read both bodies to completion: fetch resolves when the SSE headers
    // arrive, so asserting before that would race the delayed caller.
    const responses = await Promise.all([
      rpc(CALL_GET_AGENT_PROMPT, { Authorization: "Bearer sk_AAA" }),
      rpc(CALL_GET_AGENT_PROMPT, { Authorization: "Bearer sk_BBB" }),
    ]);
    await Promise.all(responses.map((r) => r.text()));

    // The whole reason the credentials moved out of module scope.
    // Every /agent call must carry the key of the caller that asked for it. The
    // delayed caller's header is constructed after the other one ran, so a
    // last-writer-wins context would hand it the wrong key here.
    // Group every upstream call by the key it carried. Each caller must appear
    // with its own key and only its own.
    const byKey = new Map<string | undefined, number>();
    for (const call of upstream) byKey.set(call.authorization, (byKey.get(call.authorization) ?? 0) + 1);

    expect([...byKey.keys()].sort()).toEqual(["Bearer sk_AAA", "Bearer sk_BBB"]);
    // Both callers ran the same tool, so both must have made the same number of
    // upstream calls. A leaked context shows up as a lopsided split.
    expect(byKey.get("Bearer sk_AAA")).toBe(byKey.get("Bearer sk_BBB"));
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

  it("answers a timed-out call instead of ending the stream silently", async () => {
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "300");
    // An upstream that never responds, and honours the abort so the test ends.
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.includes("console.example")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, organizationId: "o", data: { _id: "u" } }),
        };
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live" });
    const body = await res.text();

    // Previously this ended the stream with nothing in it: the client saw a
    // 200 with a zero-byte body and waited forever.
    expect(body).toContain("-32001");
    expect(body).toContain("too long");
  });

  it("answers every id in a batch when it times out", async () => {
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "300");
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.includes("console.example")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, organizationId: "o", data: { _id: "u" } }),
        };
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const res = await rpc(
      [
        { ...CALL_GET_AGENTS, id: 101 },
        { ...CALL_GET_AGENTS, id: 102 },
      ],
      { Authorization: "Bearer sk_live" }
    );
    const body = await res.text();

    // One frame with id null answers neither sub-request, so a client
    // correlating by id hangs on both.
    expect(body).toContain("101");
    expect(body).toContain("102");
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
