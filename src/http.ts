import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type RequestHandler, type Response } from "express";

import { basesFromEnv, optionalContext, runWithContext } from "./context.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { consoleConfigFromEnv } from "./console-client.js";
import { createApiKeyVerifier } from "./verifier.js";

/**
 * Hosted entrypoint. The stdio server in index.ts is unchanged and still the
 * path for local use; this serves many callers from one process, so every
 * request carries its own credentials and nothing is held between requests.
 */

/** Must exceed the central-ingress ALB idle_timeout (240s), else the ALB reuses a socket we closed → 502. */
const KEEP_ALIVE_TIMEOUT_MS = 250_000;
const HEADERS_TIMEOUT_MS = 251_000;

/**
 * Read a positive-integer env var, or fall back to the default.
 *
 * `Number("")` is 0 and `Number("180s")` is NaN, and a Helm template renders an
 * unset value as "". Passed to setTimeout both fire after about 1ms, so every
 * request would time out immediately. Anything unusable is ignored and logged.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // Below 1 floors to 0, and a 0ms deadline times every request out at once.
  if (!Number.isFinite(parsed) || parsed < 1) {
    logEvent("invalid_env_value", { name, value: raw.slice(0, 40), using: fallback });
    return fallback;
  }
  return Math.floor(parsed);
}

/** Budget for in-flight tool calls to finish once SIGTERM arrives. Must stay under
 *  terminationGracePeriodSeconds minus preStopSleepSeconds. */
function drainTimeoutMs(): number {
  return positiveIntFromEnv("HTTP_DRAIN_TIMEOUT_MS", 185_000);
}

/**
 * Hard cap on one request. Sits below the drain budget so a deploy never has to
 * force-kill work, and bounds a tool that hangs upstream well inside the ALB's
 * 240s idle timeout, so the caller gets an answer rather than a 504 from the ALB.
 */
function requestTimeoutMs(): number {
  return positiveIntFromEnv("MCP_REQUEST_TIMEOUT_MS", 180_000);
}

/** Upstream bases shared by every request. Only the caller's key varies. */
function upstreamsFromEnv() {
  // basesFromEnv is the one definition of these vars and their defaults.
  return basesFromEnv();
}

/**
 * A fresh server and transport per request.
 *
 * Stateless mode (sessionIdGenerator: undefined) means any pod can serve any
 * request — no sticky routing, no shared event store, and rolling deploys and
 * autoscaling are safe by construction. Sharing one transport across callers
 * would risk JSON-RPC id collisions between them, so each request gets its own
 * and both are closed when the response ends.
 */
async function handleMcpRequest(
  req: Request,
  res: Response,
  abort: AbortController,
  timeoutMs: number
): Promise<void> {
  const server = new McpServer(
    { name: "smallest", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );
  registerTools(server);
  registerResources(server);

  // Nothing in the tool surface streams, so plain JSON replies: one body per
  // request is simpler for proxies and access logs than an SSE stream.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // A rejection from either close would otherwise be unhandled, and an
  // unhandled rejection terminates the process — a client disconnect must not
  // be able to take the pod down.
  const closeQuietly = () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  };

  // Tags every event below with the id on this request's access line.
  const requestId = optionalContext()?.requestId;

  // Protocol-level failures (bad protocol version, oversized batch, malformed
  // JSON-RPC) are reported through these and would otherwise be silent.
  transport.onerror = (error) => logEvent("mcp_transport_error", { requestId, error: error.message });
  server.server.onerror = (error) => logEvent("mcp_server_error", { requestId, error: error.message });

  const deadline = setTimeout(() => {
    logEvent("mcp_request_timeout", { requestId, timeoutMs });
    // Stop the upstream work too. Without this the tool keeps running against
    // the Atoms API long after the caller has been answered.
    abort.abort(new Error("MCP request deadline exceeded"));

    // A JSON-RPC error for each id, not an HTTP 504: clients read a 504 as a
    // transport failure and some retry it, and a retried make_call is a second
    // chargeable call.
    if (!res.headersSent) {
      res.status(200).json(jsonRpcErrors(req.body, "The tool call took too long"));
    } else {
      res.end();
    }
    closeQuietly();
  }, timeoutMs);

  // Clear the deadline here too: on a disconnect the transport drops the
  // pending reply, handleRequest never settles, and the finally below never
  // runs, so the timer would hold this server for the full deadline and then
  // log a timeout for a request that is long gone.
  res.on("close", () => {
    clearTimeout(deadline);
    closeQuietly();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    clearTimeout(deadline);
  }
}

/** Longest method or tool list the access log keeps; names come from the caller. */
const MAX_LOGGED_NAMES = 200;

/** Methods and tool names in a JSON-RPC body, for the access log. Never arguments. */
function describeRpc(body: unknown): { method: string; tool?: string } {
  const calls = (Array.isArray(body) ? body : [body]).filter(
    (c): c is { method?: unknown; params?: { name?: unknown } } => typeof c === "object" && c !== null
  );
  const methods = calls.map((c) => (typeof c.method === "string" ? c.method : "?"));
  const tools = calls
    .filter((c) => c.method === "tools/call" && typeof c.params?.name === "string")
    .map((c) => c.params!.name as string);
  return {
    method: methods.join(",").slice(0, MAX_LOGGED_NAMES) || "?",
    ...(tools.length ? { tool: tools.join(",").slice(0, MAX_LOGGED_NAMES) } : {}),
  };
}

/**
 * Every id in the request, so a late error can be attributed to all of them. A
 * batch carries several, and answering one null frame leaves a client
 * correlating by id waiting on every sub-request it sent.
 */
function requestIdsFrom(body: unknown): Array<string | number | null> {
  const idOf = (entry: unknown): string | number | null => {
    if (entry && typeof entry === "object") {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
    return null;
  };

  if (Array.isArray(body)) {
    const ids = body.map(idOf).filter((id) => id !== null);
    return ids.length > 0 ? ids : [null];
  }
  return [idOf(body)];
}

/** One JSON-RPC error per id, shaped like the request: an array for a batch. */
function jsonRpcErrors(body: unknown, message: string): unknown {
  const errors = requestIdsFrom(body).map((id) => ({ jsonrpc: "2.0", id, error: { code: -32001, message } }));
  return Array.isArray(body) ? errors : errors[0];
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ...fields }));
}

/** RFC 9110 requires Allow on a 405. */
function methodNotAllowed(_req: Request, res: Response): void {
  res.set("Allow", "POST");
  res.status(405).json({
    error: "method_not_allowed",
    error_description: "This server is stateless; use POST /mcp",
  });
}

function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found" });
}

/** Browser origins allowed to call /mcp, from MCP_ALLOWED_ORIGINS (comma separated). */
function allowedOriginsFromEnv(): Set<string> {
  return new Set(
    (process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

/**
 * The Streamable HTTP spec makes Origin validation a MUST. A request with no
 * Origin is server to server (Claude, ChatGPT, IDEs, agents) and passes. Runs
 * before auth, so a foreign page costs no console lookup.
 */
function checkOrigin(allowed: Set<string>): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || allowed.has(origin)) {
      next();
      return;
    }
    res.status(403).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Origin not allowed" } });
  };
}

const AUTH_HINT =
  "Send your Atoms API key as Authorization: Bearer sk_... (Atoms console, Settings > API Keys)";

/**
 * requireBearerAuth answers a missing header with "Missing Authorization
 * header". Clients show that string, and with no OAuth metadata to discover
 * it is the only hint the user gets, so say how to authenticate instead.
 */
const requireAuthorizationHeader: RequestHandler = (req, res, next) => {
  if (req.headers.authorization) {
    next();
    return;
  }
  res.set("WWW-Authenticate", `Bearer error="invalid_token", error_description="${AUTH_HINT}"`);
  res.status(401).json({ error: "invalid_token", error_description: AUTH_HINT });
};

/** Protocol versions from 2025-06-18 on removed JSON-RPC batching. */
const FIRST_VERSION_WITHOUT_BATCHES = "2025-06-18";

const rejectBatchesOnNewProtocol: RequestHandler = (req, res, next) => {
  const version = req.headers["mcp-protocol-version"];
  // Dates in ISO form compare correctly as strings.
  if (Array.isArray(req.body) && typeof version === "string" && version >= FIRST_VERSION_WITHOUT_BATCHES) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Batches are not supported in protocol version ${version}` },
    });
    return;
  }
  next();
};

/**
 * Parses the JSON-RPC body, answering a parse failure in the protocol's own
 * shape rather than with express's HTML error page.
 */
const parseJsonRpcBody: RequestHandler = (req, res, next) => {
  express.json({ limit: "4mb" })(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }
    const tooLarge = (error as { type?: string }).type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: tooLarge ? "Request body too large" : "Parse error",
      },
    });
  });
};

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // One hop, the ALB, so req.ip is the caller once a rate limiter reads it.
  app.set("trust proxy", 1);

  const upstreams = upstreamsFromEnv();
  const verifier = createApiKeyVerifier();
  const allowedOrigins = allowedOriginsFromEnv();

  let draining = false;

  // Readiness failing stops new connections, but a busy ALB keep-alive socket
  // would keep carrying requests until the target is deregistered.
  app.use((_req, res, next) => {
    if (draining) res.set("Connection", "close");
    next();
  });

  // Liveness is about the process; readiness is about whether it should receive
  // new traffic. Deliberately not a console ping — a console blip would pull
  // every pod out of rotation at once, turning a partial outage into a total one.
  app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/health/ready", (_req, res) => {
    if (draining) {
      res.status(503).json({ status: "draining" });
      return;
    }
    res.status(200).json({ status: "ok" });
  });

  // The body parser is mounted on the route AFTER auth on purpose: mounted
  // globally it let an unauthenticated caller make the pod buffer megabytes,
  // and express's default handler answered a malformed body with an HTML page
  // carrying a stack trace and absolute server paths.
  app.post(
    "/mcp",
    checkOrigin(allowedOrigins),
    requireAuthorizationHeader,
    requireBearerAuth({ verifier }),
    parseJsonRpcBody,
    rejectBatchesOnNewProtocol,
    async (req, res) => {
      const auth = req.auth;
      const apiKey = auth?.token;

      if (typeof apiKey !== "string" || apiKey.length === 0) {
        // requireBearerAuth succeeded but the verifier returned no key — a bug on
        // our side, not a bad credential, so it must not read as a 401.
        res.status(500).json({ error: "server_error", error_description: "No API key resolved for this request" });
        return;
      }

      const requestId = randomUUID();
      res.setHeader("X-Request-Id", requestId);
      const startedAt = Date.now();
      const timeoutMs = requestTimeoutMs();

      const abort = new AbortController();
      // A client that hangs up should stop the work it asked for.
      // Only when it did hang up. Aborting after a normal finish too made every
      // request's signal carry an Error whose stack held this response and its
      // server, which anything still listening kept alive.
      res.on("close", () => {
        if (!res.writableFinished) abort.abort(new Error("client disconnected"));
      });

      // The verifier resolved the key's own org and user; carry them so tools
      // don't re-derive the org from the key creator's org list.
      const orgId = typeof auth?.extra?.orgId === "string" ? auth.extra.orgId : undefined;
      const userId = typeof auth?.extra?.userId === "string" ? auth.extra.userId : undefined;

      // One structured line per request, success included: without it an incident
      // has no request rate, tool mix, status or latency, and no per-org view.
      // "close" rather than "finish", which never fires when the client hangs up.
      res.on("close", () => {
        logEvent("mcp_request", {
          requestId,
          orgId,
          ...describeRpc(req.body),
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          aborted: !res.writableFinished,
        });
      });

      try {
        await runWithContext(
          {
            apiKey,
            ...upstreams,
            orgId,
            userId,
            signal: abort.signal,
            requestId,
            deadlineAt: startedAt + timeoutMs,
          },
          () => handleMcpRequest(req, res, abort, timeoutMs)
        );
      } catch (error) {
        logEvent("mcp_request_failed", {
          requestId,
          orgId: auth?.extra?.orgId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "server_error", error_description: "Internal error" });
        } else if (!res.writableEnded) {
          // Close it rather than leaving the socket to keepAliveTimeout.
          res.end();
        }
      }
    }
  );

  // Stateless mode has no server-initiated stream and no session to delete, so
  // every other verb is answered here rather than left to a 404 HTML page.
  app.all("/mcp", methodNotAllowed);

  app.use(notFound);

  return {
    app,
    startDraining: () => {
      draining = true;
    },
  };
}

/** Loopback and in-cluster service names have no public hop, so http is fine there. */
function isInternalHost(hostname: string): boolean {
  // IPv6 literals have no dots, so without this any of them would pass.
  if (hostname.startsWith("[")) return hostname === "[::1]";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    !hostname.includes(".") ||
    hostname.endsWith(".svc") ||
    hostname.endsWith(".svc.cluster.local")
  );
}

/**
 * The first base that is unusable, or null. Each one receives a customer's key
 * (console, our service key), so plain http to a public host sends it in
 * cleartext, and a value with no scheme fails every request while the pods
 * still report ready.
 */
export function invalidUpstreamBase(bases: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(bases)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `${name} is not a valid URL`;
    }
    // fetch refuses a URL with credentials in it, so every call would fail.
    if (url.username || url.password) return `${name} must not contain credentials`;
    if (url.protocol === "https:") continue;
    if (url.protocol === "http:" && isInternalHost(url.hostname)) continue;
    return `${name} must use https unless it points at localhost or an in-cluster service`;
  }
  return null;
}

export function startServer(port: number): Server {
  // Without these, the pod starts, passes both probes, and answers 500 to every
  // request — a rollout goes fully green while serving nothing. Better to fail
  // the rollout.
  const consoleConfig = consoleConfigFromEnv();
  if (!consoleConfig) {
    console.error(
      JSON.stringify({
        event: "mcp_http_misconfigured",
        error: "CONSOLE_BACKEND_URL and CONSOLE_API_KEY are required",
      })
    );
    process.exit(1);
  }

  const bases = basesFromEnv();
  const badBase = invalidUpstreamBase({
    ATOMS_API_URL: bases.apiUrl,
    WAVES_API_URL: bases.wavesUrl,
    PAYMENTS_API_URL: bases.paymentsUrl,
    CONSOLE_BACKEND_URL: consoleConfig.url,
  });
  if (badBase) {
    console.error(JSON.stringify({ event: "mcp_http_misconfigured", error: badBase }));
    process.exit(1);
  }

  const { app, startDraining } = createApp();
  const server = app.listen(port, () => {
    console.error(JSON.stringify({ event: "mcp_http_listening", port }));
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Fail readiness first so the load balancer stops sending new requests,
    // then let in-flight tool calls finish inside the drain budget.
    startDraining();
    console.error(JSON.stringify({ event: "mcp_http_shutdown", signal }));

    const force = setTimeout(() => {
      console.error(JSON.stringify({ event: "mcp_http_shutdown_forced" }));
      process.exit(1);
    }, drainTimeoutMs());
    force.unref();

    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });

    // server.close() waits for every connection to end, and keepAliveTimeout is
    // 250s. A request already in flight at SIGTERM was answered keep-alive, so
    // its socket goes idle only after this point; reaping once would leave it
    // open and force-exit every rolling deploy. Keep reaping until close.
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 1_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

// Start only when run directly (the image's CMD), never on import — a test or
// tool importing this module must not bind a port as a side effect.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  startServer(positiveIntFromEnv("PORT", 8092));
}
