import { ATOMS_API_URL } from "./config.js";

interface AuthenticatedOrg {
  orgId: string;
  userId: string;
}

const ATOMS_API_KEY = process.env.ATOMS_API_KEY;

let cachedOrg: AuthenticatedOrg | null = null;

/**
 * Resolves the ATOMS_API_KEY environment variable to an organization ID.
 * Calls the atoms-main-backend account endpoint which validates the API key
 * via the console service and returns the user's org info.
 *
 * Uses fetch directly instead of atomsApi to avoid circular dependency
 * (atomsApi calls getAuthenticatedOrg, which would call atomsApi again).
 */
export async function getAuthenticatedOrg(): Promise<AuthenticatedOrg> {
  if (cachedOrg) return cachedOrg;

  if (!ATOMS_API_KEY) {
    throw new Error("ATOMS_API_KEY environment variable is required");
  }

  const response = await fetch(`${ATOMS_API_URL}/account/get-account-details`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ATOMS_API_KEY}`,
    },
  });

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Invalid or revoked ATOMS_API_KEY. " +
          "Check your API key in the Atoms console (Settings > API Keys)."
      );
    }
    throw new Error(`Failed to verify API key: ${response.status} ${JSON.stringify(data)}`);
  }

  const orgs = data?.organizations;

  if (!orgs || orgs.length === 0) {
    throw new Error("No organizations found for this API key.");
  }

  cachedOrg = {
    orgId: orgs[0].orgId,
    userId: data.userId,
  };

  return cachedOrg;
}
