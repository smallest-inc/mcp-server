import { AsyncLocalStorage } from "node:async_hooks";

/** Default API bases. Overridable per context for non-prod environments. */
export const DEFAULT_ATOMS_API_URL = "https://api.smallest.ai/atoms/v1";
export const DEFAULT_WAVES_API_URL = "https://api.smallest.ai/waves/v1";
export const DEFAULT_PAYMENTS_API_URL = "https://api.smallest.ai/payment/v1";

/**
 * The credentials and endpoints belonging to ONE caller.
 *
 * The stdio server serves a single user from a single process, so it resolves
 * this once at startup and stores it as a process-wide default. A hosted HTTP
 * server serves many callers from one process and must establish a context per
 * request instead — which is why this is AsyncLocalStorage and not a module
 * constant. Reading credentials from module scope (what this file replaces)
 * would let one caller's key and organization serve another caller's request.
 */
export interface RequestContext {
  apiKey: string;
  /** Atoms API base, no trailing slash. The chat WebSocket base is derived from it. */
  apiUrl: string;
  /** Waves API base, no trailing slash. */
  wavesUrl: string;
  /** Payments API base, no trailing slash. */
  paymentsUrl: string;
  /**
   * True only for the stdio entrypoint, where the caller is the key owner on
   * their own machine and upstream detail is theirs to see. Anything else is
   * treated as a stranger, so an entrypoint that forgets to set this fails
   * closed instead of leaking internal hosts.
   */
  localCaller?: boolean;
  /**
   * The organization the API key belongs to, when the caller was authenticated
   * by a verifier that already resolved it. Hosted, this is console's
   * organizationId for the key; without it, getAuthenticatedOrg falls back to
   * the key creator's first organization, which is a different org whenever the
   * key does not belong to their first one.
   */
  orgId?: string;
  /** The user the API key belongs to, resolved alongside orgId. */
  userId?: string;
  /**
   * Aborted when the caller's request ends or hits its deadline. Upstream calls
   * honour it, so a tool that outlives its request stops doing work instead of
   * holding an outbound socket until the upstream gives up.
   */
  signal?: AbortSignal;
}

const store = new AsyncLocalStorage<RequestContext>();

let processDefault: RequestContext | null = null;

/**
 * Set the fallback context for single-tenant processes (stdio).
 * Multi-tenant servers must leave this null and use runWithContext instead, so
 * that a request arriving without credentials fails rather than silently
 * borrowing someone else's.
 */
export function setProcessDefault(context: RequestContext | null): void {
  processDefault = context;
}

/** Run `fn` with `context` in scope. Everything awaited inside inherits it. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return store.run(context, fn);
}

/**
 * The calling context, or null when nothing established one.
 *
 * For the handful of upstream endpoints that are public: they still need a base
 * URL, but must not demand a credential the caller may not have.
 */
export function optionalContext(): RequestContext | null {
  return store.getStore() ?? processDefault;
}

/**
 * The calling context. Throws if nothing established one — which for the stdio
 * server means ATOMS_API_KEY was unset.
 */
export function requireContext(purpose?: string): RequestContext {
  const context = store.getStore() ?? processDefault;
  if (!context) {
    throw new Error(
      `ATOMS_API_KEY environment variable is required${purpose ? ` ${purpose}` : ""}`
    );
  }
  return context;
}

/** Whether the current caller may be a stranger. Never throws; defaults to true. */
export function isHosted(): boolean {
  return (store.getStore() ?? processDefault)?.localCaller !== true;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The stdio entrypoint's context: the env's, marked as the key owner's own. */
export function localContextFromEnv(): RequestContext | null {
  const context = contextFromEnv();
  return context && { ...context, localCaller: true };
}

/**
 * The configured upstream bases, with no credential attached.
 *
 * contextFromEnv returns null when ATOMS_API_KEY is unset, which is right for
 * anything needing a credential — but it would also discard a configured
 * WAVES_API_URL, so a public call made before a key is pasted would silently go
 * to production instead of wherever the operator pointed it.
 */
export function basesFromEnv(): Omit<RequestContext, "apiKey"> {
  // Trailing slashes are stripped because every caller appends a path that
  // already starts with one — a base ending in "/" would produce "//agent".
  return {
    apiUrl: stripTrailingSlash(process.env.ATOMS_API_URL || DEFAULT_ATOMS_API_URL),
    wavesUrl: stripTrailingSlash(process.env.WAVES_API_URL || DEFAULT_WAVES_API_URL),
    paymentsUrl: stripTrailingSlash(process.env.PAYMENTS_API_URL || DEFAULT_PAYMENTS_API_URL),
  };
}

/**
 * Build a context from the environment, or null when no key is set.
 *
 * Returning null rather than throwing keeps today's behaviour: the server still
 * starts without a key and fails on the first tool call, so a user who is still
 * editing their MCP config sees a tool error instead of a server that won't boot.
 */
export function contextFromEnv(): RequestContext | null {
  const apiKey = process.env.ATOMS_API_KEY;
  if (!apiKey) return null;
  return { apiKey, ...basesFromEnv() };
}
