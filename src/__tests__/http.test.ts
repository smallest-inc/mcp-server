import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, invalidUpstreamBase } from "../http.js";
import { clearValidationCache } from "../verifier.js";

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
  const upstream: Array<{ url: string; authorization?: string; requestId?: string }> = [];

  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.startsWith(base)) return realFetch(input, init);

    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const requestId = (init?.headers as Record<string, string> | undefined)?.["X-Request-Id"];

    // Delay the FIRST of the tool's two sequential calls, so the second one
    // reads the context after the other caller has established its own.
    if (options.delayFor && url.includes("/agent/") && authorization?.includes(options.delayFor)) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    // The account lookup is validated strictly, so it needs a real shape.
    if (url.includes("/account/get-account-details")) {
      const token = authorization?.replace("Bearer ", "") ?? "unknown";
      upstream.push({ url, authorization, requestId });
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

    upstream.push({ url, authorization, requestId });

    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });

  return upstream;
}

async function rpc(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return realFetch(`${base}/mcp`, {
    signal,
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
  vi.stubEnv("MCP_ALLOWED_ORIGINS", "https://allowed.example");

  const created = createApp();
  draining = created.startDraining;
  server = await new Promise<Server>((resolve) => {
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // Validations are cached per key, so one test's console answer must not
  // decide the next one's.
  clearValidationCache();
  vi.restoreAllMocks();
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
    // With no OAuth metadata to discover, this text is the user's only hint.
    expect((await res.json()).error_description).toMatch(/Authorization: Bearer sk_/);
  });

  it("refuses a browser origin that is not allowed, before any console call", async () => {
    let consoleCalls = 0;
    stubUpstreams();
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("console.example")) consoleCalls += 1;
      return stubbed(input, init);
    });

    const res = await rpc(INITIALIZE, {
      Authorization: "Bearer sk_live0000000000000000000000000000",
      Origin: "https://evil.example",
    });

    // The Streamable HTTP spec makes this a MUST.
    expect(res.status).toBe(403);
    expect(consoleCalls).toBe(0);
  });

  it("lets a listed origin through", async () => {
    stubUpstreams();

    const res = await rpc(INITIALIZE, {
      Authorization: "Bearer sk_live0000000000000000000000000000",
      Origin: "https://allowed.example",
    });

    expect(res.status).toBe(200);
  });

  it("never hands an upstream 5xx body to the caller", async () => {
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
      return {
        ok: false,
        status: 502,
        json: async () => ({ message: "connect ECONNREFUSED atoms-mainbackend.internal:4000" }),
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    const body = await res.text();

    expect(body).toContain("the upstream service failed");
    expect(body).not.toContain("atoms-mainbackend");
    expect(body).not.toContain("4000");
  });

  it("rejects a key console does not recognise", async () => {
    stubUpstreams({ consoleStatus: 401 });

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_bad00000000000000000000000000000" });

    expect(res.status).toBe(401);
  });

  it("does not report a console outage as a bad key", async () => {
    stubUpstreams({ consoleStatus: 503 });

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_live0000000000000000000000000000" });

    // 500, not 401 — otherwise every user is told to rotate a working key.
    expect(res.status).toBe(500);
  });

  it("initializes for a valid key", async () => {
    stubUpstreams();

    const res = await rpc(INITIALIZE, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('"serverInfo"');
    expect(body).toContain('"smallest"');
  });

  it("runs a tool, and sends the caller's own key upstream", async () => {
    const upstream = stubUpstreams();

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    expect(res.status).toBe(200);

    // The previous version of this test only sent `initialize`, which touches
    // no context, no tool and no upstream — it passed with runWithContext
    // deleted. This one fails if the context is not established.
    expect(upstream.length).toBeGreaterThan(0);
    for (const call of upstream) {
      expect(call.authorization).toBe("Bearer sk_live0000000000000000000000000000");
    }
  });

  it("forwards its request id upstream, so our logs join main-backend's", async () => {
    const upstream = stubUpstreams();

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    const requestId = res.headers.get("X-Request-Id");

    expect(requestId).toBeTruthy();
    const atomsCalls = upstream.filter((c) => c.url.includes("/agent"));
    expect(atomsCalls.length).toBeGreaterThan(0);
    for (const call of atomsCalls) expect(call.requestId).toBe(requestId);
  });

  it("writes one access-log line per request, including successes", async () => {
    stubUpstreams();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    await res.text();
    // "finish" fires after the last byte is handed to the socket.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const entries = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.event === "mcp_request");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: res.headers.get("X-Request-Id"),
      orgId: "org-for-sk_live0000000000000000000000000000",
      method: "tools/call",
      tool: "get_agents",
      status: 200,
      aborted: false,
    });
    expect(typeof entries[0].durationMs).toBe("number");
    // Tool arguments can carry prompts and phone numbers; they stay out of logs.
    expect(JSON.stringify(entries[0])).not.toContain("arguments");
  });

  it("keeps two concurrent callers' credentials apart", async () => {
    const upstream = stubUpstreams({ delayFor: "sk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });

    // Read both bodies to completion: fetch resolves when the headers
    // arrive, so asserting before that would race the delayed caller.
    const responses = await Promise.all([
      rpc(CALL_GET_AGENT_PROMPT, { Authorization: "Bearer sk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      rpc(CALL_GET_AGENT_PROMPT, { Authorization: "Bearer sk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
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

    expect([...byKey.keys()].sort()).toEqual(["Bearer sk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Bearer sk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]);
    // Both callers ran the same tool, so both must have made the same number of
    // upstream calls. A leaked context shows up as a lopsided split.
    expect(byKey.get("Bearer sk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(byKey.get("Bearer sk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
  });

  it("answers a malformed body in JSON-RPC, without a stack trace", async () => {
    stubUpstreams();

    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer sk_live0000000000000000000000000000",
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

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    const body = await res.text();

    // A JSON-RPC error, not an HTTP 504, which clients treat as a transport
    // failure and may retry.
    expect(res.status).toBe(200);
    expect(body).toContain("-32001");
    expect(body).toContain("too long");
  });

  it("aborts the upstream work when the deadline fires", async () => {
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "300");
    let upstreamSignal: AbortSignal | undefined;
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
      upstreamSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" }).then((r) => r.text());

    // Answering the caller is not enough: without this the tool keeps running
    // against the Atoms API, holding an outbound socket until it gives up.
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(upstreamSignal?.aborted).toBe(true);
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
      { Authorization: "Bearer sk_live0000000000000000000000000000" }
    );
    const body = await res.text();

    // One frame with id null answers neither sub-request, so a client
    // correlating by id hangs on both.
    expect(body).toContain("101");
    expect(body).toContain("102");
  });

  it("rejects a batch on a protocol version that removed batching", async () => {
    stubUpstreams();

    const res = await rpc([CALL_GET_AGENTS, { ...CALL_GET_AGENTS, id: 3 }], {
      Authorization: "Bearer sk_live0000000000000000000000000000",
      "MCP-Protocol-Version": "2025-06-18",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it("does not advertise the framework", async () => {
    const res = await realFetch(`${base}/health/live`);
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("closes connections while draining, so a busy ALB socket stops carrying requests", async () => {
    draining();

    const res = await realFetch(`${base}/health/live`);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("clears the deadline when the client hangs up, instead of logging a timeout later", async () => {
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "300");
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.includes("console.example")) {
        return { ok: true, status: 200, json: async () => ({ success: true, organizationId: "o", data: { _id: "u" } }) };
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const client = new AbortController();
    const pending = rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" }, client.signal)
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(lines.some((l) => l.includes('"event":"mcp_request_timeout"'))).toBe(false);
    expect(lines.some((l) => l.includes('"aborted":true'))).toBe(true);
  });

  it("does not abort a request's signal when it finished normally", async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.includes("console.example")) {
        return { ok: true, status: 200, json: async () => ({ success: true, organizationId: "o", data: { _id: "u" } }) };
      }
      // transcribe_audio hands the request's own signal to fetch.
      upstreamSignal = init?.signal;
      return { ok: true, status: 200, json: async () => ({ text: "hi" }) };
    });

    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "transcribe_audio", arguments: { audio_url: "https://cdn.example/a.wav", language: "en" } },
      },
      { Authorization: "Bearer sk_live0000000000000000000000000000" }
    );
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // An aborted signal's reason held the whole response and server alive for
    // as long as anything listened to it: about 1.3 MB per call, never freed.
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(upstreamSignal?.aborted).toBe(false);
  });

  it("ignores a sub-millisecond deadline rather than timing every request out", async () => {
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "0.5");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // createApp read the env already; the deadline is read per request.
    stubUpstreams();

    const res = await rpc(CALL_GET_AGENTS, { Authorization: "Bearer sk_live0000000000000000000000000000" });
    expect(await res.text()).not.toContain("-32001");
  });

  it("caps caller-supplied tool names in the access log", async () => {
    stubUpstreams();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    await rpc(
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "x".repeat(5_000), arguments: {} } },
      { Authorization: "Bearer sk_live0000000000000000000000000000" }
    ).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === "mcp_request");
    expect(entry?.tool.length).toBeLessThanOrEqual(200);
  });

  it("does not offer text_to_speech, which can only write to a local disk", async () => {
    stubUpstreams();

    await rpc(INITIALIZE, { Authorization: "Bearer sk_live" });
    const res = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { Authorization: "Bearer sk_live" }
    );
    const body = await res.text();

    // Hosted, "the filesystem" is a pod's ephemeral disk the caller can never
    // reach, so writing there and reporting success would be a lie.
    const tools = JSON.parse(body.replace(/^.*?data: /s, "")).result.tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("text_to_speech");
    // transcribe_audio stays: it already accepts audio_url.
    expect(names).toContain("transcribe_audio");
  });

  it("rejects a local path, and says what to use instead", async () => {
    stubUpstreams();

    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "transcribe_audio", arguments: { file_path: "~/Desktop/rec.wav", language: "en" } },
      },
      { Authorization: "Bearer sk_live" }
    );
    const body = await res.text();

    expect(body).toContain("audio_url");
    expect(body).toContain("isError");
  });

  it("honours audio_url even when a file_path is also supplied", async () => {
    const upstream = stubUpstreams();

    await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "transcribe_audio",
          arguments: {
            file_path: "~/Desktop/rec.wav",
            audio_url: "https://cdn.example/a.wav",
            language: "en",
          },
        },
      },
      { Authorization: "Bearer sk_live" }
    );

    // Locally the URL wins and the path is ignored; hosted should behave the
    // same rather than hard-failing on a request it can serve.
    expect(upstream.some((c) => c.url.includes("/pulse/get_text"))).toBe(true);
  });

  it("advertises no local file path on the hosted transport", async () => {
    stubUpstreams();

    const res = await rpc(
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      { Authorization: "Bearer sk_live" }
    );
    const tools = JSON.parse((await res.text()).replace(/^.*?data: /s, "")).result.tools;
    const transcribe = tools.find((t: { name: string }) => t.name === "transcribe_audio");

    // The advertised contract must match the runtime one, or the model sends a
    // path the server will always reject.
    expect(transcribe.description).not.toMatch(/on the user's machine/);
    expect(transcribe.description).toContain("audio_url");
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

describe("upstream base validation", () => {
  it("accepts https, loopback and in-cluster http", () => {
    expect(
      invalidUpstreamBase({
        A: "https://api.smallest.ai/atoms/v1",
        B: "http://atoms-mainbackend",
        C: "http://atoms-mainbackend.default.svc.cluster.local:4001/atoms/v1",
        D: "http://localhost:4000",
      })
    ).toBeNull();
  });

  it("refuses http to a public host, which would send keys in cleartext", () => {
    expect(invalidUpstreamBase({ ATOMS_API_URL: "http://api.smallest.ai/atoms/v1" })).toMatch(
      /^ATOMS_API_URL must use https/
    );
  });

  it("refuses http to an IPv6 literal, which has no dots to look internal", () => {
    expect(invalidUpstreamBase({ A: "http://[2001:db8::1]/atoms/v1" })).toMatch(/must use https/);
    expect(invalidUpstreamBase({ A: "http://[::1]:4000" })).toBeNull();
  });

  it("refuses a base with credentials in it, which fetch would reject on every call", () => {
    expect(invalidUpstreamBase({ A: "https://u:p@api.smallest.ai/atoms/v1" })).toMatch(/must not contain credentials/);
  });

  it("refuses a value with no scheme, which would fail every request", () => {
    expect(invalidUpstreamBase({ WAVES_API_URL: "api.smallest.ai/waves/v1" })).toMatch(
      /^WAVES_API_URL is not a valid URL/
    );
  });
});
