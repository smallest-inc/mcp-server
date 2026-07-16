import { getAuthenticatedOrg } from "./auth.js";

// Overridable for non-prod environments (e.g. https://api.dev.smallest.ai/atoms/v1).
const ATOMS_API_URL = process.env.ATOMS_API_URL || "https://api.smallest.ai/atoms/v1";
const ATOMS_API_KEY = process.env.ATOMS_API_KEY;

interface ApiResult {
  ok: boolean;
  status: number;
  data: any;
}

/**
 * Make an authenticated request to the Atoms main-backend API.
 * Automatically includes the API key and resolves the org context.
 */
export async function atomsApi(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<ApiResult> {
  if (!ATOMS_API_KEY) {
    throw new Error("ATOMS_API_KEY environment variable is required");
  }

  // Ensure org is resolved (validates the API key on first call)
  await getAuthenticatedOrg();

  const url = `${ATOMS_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ATOMS_API_KEY}`,
    ...extraHeaders,
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}

/** Backend discriminator (branch-model-guard.ts) for deprecated v1 versioning endpoints. */
const VERSIONING_V2_MIGRATION_ERROR = "versioning_v2_migration_required";

export function formatApiError(result: ApiResult): string {
  // Config freeze: the backend locks all config writes during a maintenance window (HTTP 423).
  // Surface it as a clear, non-alarming state — reads and test-calls are unaffected.
  if (result.status === 423) {
    return "Agent config is frozen for a maintenance window — edits are paused. Test-calls and reads still work; try your edit again shortly.";
  }

  // Deprecated v1 versioning endpoint after the branch-model cutover. This should not happen once
  // migrated; if it does, the MCP is out of date relative to the backend.
  if (result.data?.error_type === VERSIONING_V2_MIGRATION_ERROR) {
    return "This Smallest MCP server is out of date and called a deprecated endpoint. Update it (restart your editor to pull the latest, or re-run the installer), then try again.";
  }

  const msg = result.data?.message ?? result.data?.error ?? JSON.stringify(result.data);
  return `API error ${result.status}: ${msg}`;
}
