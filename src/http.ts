import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type RequestHandler, type Response } from "express";

import { DEFAULT_ATOMS_API_URL, DEFAULT_PAYMENTS_API_URL, DEFAULT_WAVES_API_URL, runWithContext } from "./context.js";
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

/** Budget for in-flight tool calls to finish once SIGTERM arrives. Must stay under
 *  terminationGracePeriodSeconds minus preStopSleepSeconds. */
const DRAIN_TIMEOUT_MS = Number(process.env.HTTP_DRAIN_TIMEOUT_MS ?? 185_000);

/**
 * Hard cap on one request. Sits below the drain budget so a deploy never has to
 * force-kill work, and bounds a tool that hangs upstream: SSE keep-alive frames
 * mean neither the ALB idle timeout nor keepAliveTimeout would ever reap it.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 180_000);

/** Upstream bases shared by every request. Only the caller's key varies. */
function upstreamsFromEnv() {
  const strip = (u: string) => u.replace(/\/+$/, "");
  return {
    apiUrl: strip(process.env.ATOMS_API_URL || DEFAULT_ATOMS_API_URL),
    wavesUrl: strip(process.env.WAVES_API_URL || DEFAULT_WAVES_API_URL),
    paymentsUrl: strip(process.env.PAYMENTS_API_URL || DEFAULT_PAYMENTS_API_URL),
  };
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
async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = new McpServer(
    { name: "smallest", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );
  registerTools(server);
  registerResources(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // A rejection from either close would otherwise be unhandled, and an
  // unhandled rejection terminates the process — a client disconnect must not
  // be able to take the pod down.
  const closeQuietly = () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  };

  // Protocol-level failures (bad protocol version, oversized batch, malformed
  // JSON-RPC) are reported through these and would otherwise be silent.
  transport.onerror = (error) => logEvent("mcp_transport_error", { error: error.message });
  server.server.onerror = (error) => logEvent("mcp_server_error", { error: error.message });

  res.on("close", closeQuietly);

  const deadline = setTimeout(() => {
    logEvent("mcp_request_timeout", { timeoutMs: REQUEST_TIMEOUT_MS });
    closeQuietly();
    if (!res.headersSent) {
      res.status(504).json({ error: "timeout", error_description: "The tool call took too long" });
    } else {
      res.end();
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    clearTimeout(deadline);
  }
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

  const upstreams = upstreamsFromEnv();
  const verifier = createApiKeyVerifier();

  let draining = false;

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
  app.post("/mcp", requireBearerAuth({ verifier }), parseJsonRpcBody, async (req, res) => {
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

    try {
      await runWithContext({ apiKey, ...upstreams }, () => handleMcpRequest(req, res));
    } catch (error) {
      logEvent("mcp_request_failed", {
        requestId,
        orgId: auth?.extra?.orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "server_error", error_description: "Internal error" });
      }
    }
  });

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

export function startServer(port: number): Server {
  // Without these, the pod starts, passes both probes, and answers 500 to every
  // request — a rollout goes fully green while serving nothing. Better to fail
  // the rollout.
  if (!consoleConfigFromEnv()) {
    console.error(
      JSON.stringify({
        event: "mcp_http_misconfigured",
        error: "CONSOLE_BACKEND_URL and CONSOLE_API_KEY are required",
      })
    );
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
    }, DRAIN_TIMEOUT_MS);
    force.unref();

    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });

    // server.close() waits for every connection to end. Node 18 does not reap
    // idle keep-alive sockets on its own, and keepAliveTimeout is 250s, so one
    // idle ALB connection would stall the callback past the drain budget and
    // make every rolling deploy force-exit.
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

// Start only when run directly (the image's CMD), never on import — a test or
// tool importing this module must not bind a port as a side effect.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  startServer(Number(process.env.PORT ?? 8092));
}
