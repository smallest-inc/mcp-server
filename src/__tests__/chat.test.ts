import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithContext, type RequestContext } from "../context.js";

const sends: Array<{ text: string; timeoutMs: number }> = [];
let sendDelayMs = 0;

vi.mock("../chat-client.js", () => ({
  AtomsChatClient: class {
    callId = "call-1";
    closedReason: string | null = null;
    transcript: Array<{ role: string; text: string }> = [];
    async connect() {
      return { callId: "call-1", sessionId: "s-1", greeting: null };
    }
    async send(text: string, timeoutMs: number) {
      sends.push({ text, timeoutMs });
      await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      this.transcript.push({ role: "user", text }, { role: "agent", text: `re: ${text}` });
      return `re: ${text}`;
    }
    async waitForClose() {}
    close() {}
  },
}));

const { registerChatWithAgent } = await import("../tools/chat.js");

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function chatHandler(): Handler {
  let handler: Handler | undefined;
  registerChatWithAgent({
    registerTool: (_name: string, _config: unknown, h: Handler) => {
      handler = h;
    },
  } as never);
  return handler!;
}

const BASE: RequestContext = {
  apiKey: "key-a",
  apiUrl: "https://a.example/atoms/v1",
  wavesUrl: "https://a.example/waves/v1",
  paymentsUrl: "https://a.example/payment/v1",
};

const PARAMS = {
  agent_id: "agent-1",
  messages: ["one", "two", "three"],
  reply_timeout_ms: 30_000,
  settle_ms: 500,
  greeting_wait_ms: 0,
};

afterEach(() => {
  sends.length = 0;
  sendDelayMs = 0;
});

describe("chat_with_agent under the hosted deadline", () => {
  it("returns the transcript so far instead of being cut off with nothing", async () => {
    sendDelayMs = 600;
    // 5s reserve + 3.5s: room to start one turn, not a second after it takes 600ms.
    const context = { ...BASE, deadlineAt: Date.now() + 8_500 };

    const result = await runWithContext(context, () => chatHandler()(PARAMS));
    const body = JSON.parse(result.content[0].text);

    expect(body.turns_sent).toBe(1);
    expect(body.turns_requested).toBe(3);
    expect(body.error).toMatch(/budget ran out/);
    expect(body.transcript).toHaveLength(2);
    // The one turn it did send waited only as long as the budget allowed.
    expect(sends[0].timeoutMs).toBeLessThanOrEqual(3_500);
  });

  it("sends every turn with the full reply timeout on stdio, which has no deadline", async () => {
    const result = await runWithContext(BASE, () => chatHandler()(PARAMS));
    const body = JSON.parse(result.content[0].text);

    expect(body.turns_sent).toBe(3);
    expect(body.error).toBeNull();
    expect(sends.map((s) => s.timeoutMs)).toEqual([30_000, 30_000, 30_000]);
  });
});
