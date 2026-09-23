import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { DEFAULT_ATOMS_API_URL, DEFAULT_PAYMENTS_API_URL, DEFAULT_WAVES_API_URL, runWithContext } from "./context.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
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

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

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

  app.post("/mcp", requireBearerAuth({ verifier }), async (req, res) => {
    const auth = req.auth;
    const apiKey = auth?.extra?.apiKey;

    if (typeof apiKey !== "string") {
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
      console.error(
        JSON.stringify({
          event: "mcp_request_failed",
          requestId,
          orgId: auth?.extra?.orgId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "server_error", error_description: "Internal error" });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete, so
  // the two other verbs the spec defines are answered rather than left to 404.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      error: "method_not_allowed",
      error_description: "This server is stateless; use POST /mcp",
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return {
    app,
    startDraining: () => {
      draining = true;
    },
  };
}

export function startServer(port: number): Server {
  const { app, startDraining } = createApp();
  const server = app.listen(port, () => {
    console.error(JSON.stringify({ event: "mcp_http_listening", port }));
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  const shutdown = (signal: string) => {
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
