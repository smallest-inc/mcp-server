import WebSocket from "ws";

/**
 * Minimal text-only client for the Atoms realtime agent — `/connect?mode=chat`.
 *
 * Speaks the documented WebSocket contract (no audio):
 *   client → server : {"type":"input_text.send","text":"..."}
 *                     {"type":"session.close"}
 *   server → client : session.created | transcript {role,text} | session.closed | error
 *
 * Auth is the raw API key on the `token` query param (the gateway's API-key
 * path). The whole exchange is text, so this needs no mic/audio handling — it
 * just sends user turns and collects the agent's `transcript` replies.
 */

export interface ChatTurn {
  role: "user" | "agent";
  text: string;
}

export interface ChatClientOptions {
  apiKey: string;
  agentId: string;
  /** Base URL, e.g. wss://api.smallest.ai/atoms/v1 (no trailing /agent/connect). */
  baseWssUrl: string;
  variables?: Record<string, string | number | boolean>;
}

interface ReplyWaiter {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AtomsChatClient {
  private ws: WebSocket | null = null;
  private waiters: ReplyWaiter[] = [];

  callId = "";
  sessionId = "";
  sampleRate = 0;
  /** Full conversation in arrival order: greeting, user echoes, agent replies. */
  readonly transcript: ChatTurn[] = [];
  closed = false;
  closedReason: string | null = null;

  private onSessionCreated: (() => void) | null = null;
  /** Reject the in-flight connect() if an error/close arrives before session.created. */
  private onConnectFailure: ((err: Error) => void) | null = null;

  constructor(private readonly opts: ChatClientOptions) {}

  private connectUrl(): string {
    const params = new URLSearchParams({
      token: this.opts.apiKey,
      agent_id: this.opts.agentId,
      mode: "chat",
    });
    if (this.opts.variables && Object.keys(this.opts.variables).length > 0) {
      params.set("variables", JSON.stringify(this.opts.variables));
    }
    return `${this.opts.baseWssUrl.replace(/\/+$/, "")}/agent/connect?${params.toString()}`;
  }

  /**
   * Open the WebSocket and resolve once `session.created` arrives. Then wait up
   * to `greetingWaitMs` for the agent's opening message (if the agent greets
   * first) so it lands in the transcript before any user turn is sent.
   *
   * @returns the call id, session id, and the greeting text (or null if the
   *   agent waits for the user to speak first).
   */
  async connect(
    greetingWaitMs = 3000,
    connectTimeoutMs = 15000
  ): Promise<{ callId: string; sessionId: string; greeting: string | null }> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.connectUrl());
      this.ws = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error("Timed out waiting for session.created"));
      }, connectTimeoutMs);

      this.onSessionCreated = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onConnectFailure = null;
        resolve();
      };
      this.onConnectFailure = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onConnectFailure = null;
        reject(err);
      };

      ws.on("message", (raw: WebSocket.RawData) => this.handleMessage(raw));
      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.failWaiters(err);
      });
      ws.on("close", () => {
        this.closed = true;
        this.failWaiters(new Error(`Chat session closed${this.closedReason ? `: ${this.closedReason}` : ""}`));
      });
    });

    // Let the opening message arrive (no-op for wait-for-user-first agents).
    // Nothing has been sent yet, so the first agent turn is the greeting.
    await this.delay(greetingWaitMs);
    const greetingTurn = this.transcript.find((t) => t.role === "agent");

    return {
      callId: this.callId,
      sessionId: this.sessionId,
      greeting: greetingTurn ? greetingTurn.text : null,
    };
  }

  /**
   * Send one user message and resolve with the agent's next reply.
   * Rejects if the session is closed or no reply arrives within `timeoutMs`.
   */
  async send(text: string, timeoutMs = 25000): Promise<string> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Chat session is not open${this.closedReason ? ` (closed: ${this.closedReason})` : ""}`);
    }
    const reply = this.nextAgentReply(timeoutMs);
    this.ws.send(JSON.stringify({ type: "input_text.send", text }));
    return reply;
  }

  /** Send session.close and shut the socket. */
  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // ignore — closing anyway
      }
    }
    this.ws?.close();
    this.closed = true;
  }

  // ---------------------------------------------------------------------------

  private nextAgentReply(timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: ReplyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for the agent's reply`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.created":
        this.callId = String(event.call_id ?? "");
        this.sessionId = String(event.session_id ?? "");
        this.sampleRate = Number(event.sample_rate ?? 0);
        this.onSessionCreated?.();
        break;

      case "transcript": {
        // pipecat emits role "assistant"; the docs/SDK use "agent". Normalize
        // everything that isn't the user to "agent".
        const role: ChatTurn["role"] = event.role === "user" ? "user" : "agent";
        const text = String(event.text ?? "");
        this.transcript.push({ role, text });
        if (role === "agent") {
          const waiter = this.waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(text);
          }
        }
        break;
      }

      case "session.closed": {
        this.closed = true;
        this.closedReason = String(event.reason ?? "ended");
        const err = new Error(`Chat session closed: ${this.closedReason}`);
        if (this.onConnectFailure) this.onConnectFailure(err);
        this.failWaiters(err);
        break;
      }

      case "error": {
        const message = `[${event.code ?? "error"}] ${event.message ?? "unknown error"}`;
        const err = new Error(message);
        // Before the session is up, an error means the connect itself failed
        // (e.g. the gateway couldn't reach NATS) — surface it to connect().
        if (this.onConnectFailure) {
          this.onConnectFailure(err);
          break;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        break;
      }

      default:
        // transcript.delta / agent.start_talking / etc. — ignored for chat.
        break;
    }
  }

  private failWaiters(err: Error): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
