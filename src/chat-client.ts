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

/**
 * Collects ONE agent turn. A turn is often several messages — a filler spoken
 * when a tool starts ("Let me find your details…"), then the real answer once
 * the tool returns. We accumulate agent messages and resolve after `quietMs`
 * of silence (the turn has settled) or when the session closes, rather than
 * resolving on the first message and racing ahead of the tool round.
 */
interface TurnCollector {
  parts: string[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  hardTimer: ReturnType<typeof setTimeout>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  /** Silence after a substantive message before the turn is considered done. */
  quietMs: number;
  /** Silence to allow after a filler ("…"), while its tool is still running. */
  toolWaitMs: number;
}

/**
 * Fillers spoken while a tool runs conventionally end with an ellipsis
 * ("Let me find your details…", "Fetching today's fund value…"). After one we
 * wait `toolWaitMs` for the real answer; after a substantive message we settle
 * quickly (`quietMs`). This keeps normal turns fast without cutting tool rounds.
 */
function looksLikeFiller(text: string): boolean {
  const t = text.trim();
  return t.endsWith("…") || t.endsWith("...");
}

export class AtomsChatClient {
  private ws: WebSocket | null = null;
  private activeTurn: TurnCollector | null = null;
  /** Resolvers waiting for the session to close (drain after the last turn). */
  private closeWaiters: Array<() => void> = [];

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
        this.failActiveTurn(err);
      });
      ws.on("close", () => {
        this.closed = true;
        // A close during a turn usually means the agent ended the call (e.g.
        // end_call fired): resolve the turn with what we collected rather than
        // erroring. Only error if the turn produced nothing at all.
        this.settleTurn(true);
        this.resolveCloseWaiters();
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
   * Send one user message and resolve with the agent's FULL turn — every agent
   * message until the turn settles (`quietMs` of silence) or the session closes.
   * This holds the connection through a tool round (filler → tool → answer)
   * instead of returning on the filler and racing ahead. Rejects only if the
   * session is closed up front or the turn produces nothing within `timeoutMs`.
   */
  async send(text: string, timeoutMs = 30000, quietMs = 2500): Promise<string> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Chat session is not open${this.closedReason ? ` (closed: ${this.closedReason})` : ""}`);
    }
    // After a filler, allow up to most of the hard budget for the tool to return.
    const toolWaitMs = Math.min(timeoutMs - 2000, 15000);
    const reply = this.collectAgentTurn(timeoutMs, quietMs, Math.max(toolWaitMs, quietMs));
    this.ws.send(JSON.stringify({ type: "input_text.send", text }));
    return reply;
  }

  /**
   * Wait for the agent to close the session on its own (e.g. an end_call
   * hangup), up to `ms`. Used to drain the last turn so a natural agent hangup
   * is observed before we tear the socket down. Resolves immediately if already
   * closed, and after `ms` if the agent never closes (caller then closes).
   */
  waitForClose(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.closeWaiters.indexOf(done);
        if (i >= 0) this.closeWaiters.splice(i, 1);
        resolve();
      }, ms);
      this.closeWaiters.push(done);
    });
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

  private collectAgentTurn(timeoutMs: number, quietMs: number, toolWaitMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const collector: TurnCollector = {
        parts: [],
        resolve,
        reject,
        quietMs,
        toolWaitMs,
        quietTimer: null,
        hardTimer: setTimeout(() => {
          if (this.activeTurn !== collector) return;
          this.activeTurn = null;
          if (collector.quietTimer) clearTimeout(collector.quietTimer);
          // Return what we have if the agent spoke at all (a slow tool that
          // never fully settled); otherwise it's a genuine no-reply timeout.
          if (collector.parts.length) resolve(collector.parts.join("\n"));
          else reject(new Error(`Timed out after ${timeoutMs}ms waiting for the agent's reply`));
        }, timeoutMs),
      };
      this.activeTurn = collector;
    });
  }

  /** Resolve the active turn with whatever has been collected. */
  private settleTurn(closing = false): void {
    const t = this.activeTurn;
    if (!t) return;
    // On a socket close with nothing collected, let failActiveTurn surface the
    // error instead of resolving an empty turn.
    if (closing && t.parts.length === 0) return;
    this.activeTurn = null;
    clearTimeout(t.hardTimer);
    if (t.quietTimer) clearTimeout(t.quietTimer);
    t.resolve(t.parts.join("\n"));
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
        if (role === "agent" && this.activeTurn) {
          // Accumulate this message into the current turn and (re)arm the quiet
          // timer — the turn resolves once the agent stops for `quietMs`, so a
          // filler followed by a tool result counts as one settled reply.
          const t = this.activeTurn;
          t.parts.push(text);
          if (t.quietTimer) clearTimeout(t.quietTimer);
          // A filler ("…") means a tool is still running — wait longer for its
          // answer; a substantive message means the turn is likely done — settle.
          const wait = looksLikeFiller(text) ? t.toolWaitMs : t.quietMs;
          t.quietTimer = setTimeout(() => this.settleTurn(), wait);
        }
        break;
      }

      case "session.closed": {
        this.closed = true;
        this.closedReason = String(event.reason ?? "ended");
        if (this.onConnectFailure) {
          // Closed before session.created — a genuine connect failure.
          this.onConnectFailure(new Error(`Chat session closed: ${this.closedReason}`));
        } else {
          // The agent ended the call (e.g. end_call): resolve the in-flight turn
          // with what it produced (the farewell), then wake any drain waiters.
          this.settleTurn(true);
        }
        this.resolveCloseWaiters();
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
        this.failActiveTurn(err);
        break;
      }

      default:
        // transcript.delta / agent.start_talking / etc. — ignored for chat.
        break;
    }
  }

  private failActiveTurn(err: Error): void {
    const t = this.activeTurn;
    if (!t) return;
    this.activeTurn = null;
    clearTimeout(t.hardTimer);
    if (t.quietTimer) clearTimeout(t.quietTimer);
    t.reject(err);
  }

  private resolveCloseWaiters(): void {
    const waiters = this.closeWaiters.splice(0);
    for (const fn of waiters) fn();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
