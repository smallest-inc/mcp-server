import { describe, expect, it } from "vitest";

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
});
