import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { AtomsChatClient } from "../chat-client.js";

describe("AtomsChatClient", () => {
  it("does not open a chargeable session for a request that was already cancelled", async () => {
    const abort = new AbortController();
    abort.abort(new Error("client disconnected"));

    const client = new AtomsChatClient({
      apiKey: "key-a",
      agentId: "agent-1",
      signal: abort.signal,
      // Unroutable: if connect() got as far as opening a socket, the test would
      // see a connection error instead of the cancellation.
      baseWssUrl: "ws://127.0.0.1:1/atoms/v1",
    });

    await expect(client.connect(0, 1_000)).rejects.toThrow(/cancelled before the chat session started/);
  });

  it("fails a turn at once when the socket closes before any reply", async () => {
    // Opens the session, then drops the connection on the first user message.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "session.created", call_id: "c1", session_id: "s1", sample_rate: 16000 }));
      socket.on("message", () => socket.close());
    });
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;

    const client = new AtomsChatClient({
      apiKey: "key-a",
      agentId: "agent-1",
      baseWssUrl: `ws://127.0.0.1:${port}/atoms/v1`,
    });

    try {
      await client.connect(0, 2_000);
      const startedAt = Date.now();
      await expect(client.send("hello", 60_000, 100)).rejects.toThrow(/Chat session closed/);
      // Not the 60s reply timeout.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      client.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});
