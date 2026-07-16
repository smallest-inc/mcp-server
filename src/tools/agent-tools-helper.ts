import { atomsApi, formatApiError } from "../api.js";
import { resolveBranch, saveConfigToBranch } from "../versioning.js";
import type { IAgentDTO } from "../types.js";

/**
 * Shared helpers for managing a single_prompt agent's config and tools.
 *
 * All edits go to a branch's draft (v2 branch model): each edit auto-opens the
 * branch's single draft and stacks onto it. Callers publish_draft once to commit.
 */

export type FetchToolsResult =
  | { ok: true; agent: IAgentDTO; branchId: string; tools: any[] }
  | { ok: false; message: string };

/**
 * Fetch the agent plus the CURRENT tools array for the chosen branch — resolved
 * from the branch's open draft when one exists (so stacked edits compose without
 * clobbering), else the branch head. Blocks conversation-flow (workflow_graph)
 * agents. `branchId` omitted → the live branch (or ask, if multiple exist).
 */
export async function fetchAgentAndTools(agentId: string, branchId?: string): Promise<FetchToolsResult> {
  const branch = await resolveBranch(agentId, branchId);
  if (!branch.ok) return { ok: false, message: branch.message };

  // Resolve the tools of the TARGET branch: its open draft when one exists (so
  // stacked edits compose), else its head revision — never the live config,
  // which would seed a non-live branch's draft from the wrong tools.
  const q = branch.value.openDraftId
    ? `?draftId=${encodeURIComponent(branch.value.openDraftId)}`
    : branch.value.headRevisionId
      ? `?versionId=${encodeURIComponent(branch.value.headRevisionId)}`
      : "";
  const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(agentId)}${q}`);
  if (!agentResult.ok) {
    if (agentResult.status === 404) return { ok: false, message: `Agent not found: ${agentId}` };
    return { ok: false, message: formatApiError(agentResult) };
  }

  const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO & {
    _resolvedConfig?: { tools?: any[] };
  };

  if (agent.workflowType === "workflow_graph") {
    return {
      ok: false,
      message:
        "Smallest MCP does not support conversation flow (workflow_graph) agents. Tools can only be managed on single_prompt agents.",
    };
  }

  // Guard against a silent wipe: a missing _resolvedConfig means we couldn't read
  // the current tools, so a wholesale write would blank them. (An empty tools
  // array on a present _resolvedConfig is a legitimate no-tools state.)
  if (!agent._resolvedConfig) {
    return {
      ok: false,
      message: "Could not resolve the agent's current tools to edit them safely. Aborting to avoid overwriting the tools list.",
    };
  }

  const tools = (agent._resolvedConfig.tools ?? []) as any[];

  return { ok: true, agent, branchId: branch.value.branchId, tools };
}

export type PersistResult = { ok: true } | { ok: false; message: string };

/**
 * Persist the full tools array to a branch's draft. The array is always sent in
 * full — the backend replaces it wholesale — so callers upsert/remove within the
 * array (against the draft-resolved read from fetchAgentAndTools) first.
 */
export async function persistAgentTools(
  agent: IAgentDTO,
  branchId: string,
  tools: any[]
): Promise<PersistResult> {
  const saved = await saveConfigToBranch(agent._id, branchId, { singlePromptConfig: { tools } });
  if (!saved.ok) return { ok: false, message: `Failed to save tools: ${saved.message}` };
  return { ok: true };
}

/** Standard hint appended when changes land in a branch draft. */
export const DRAFT_HINT =
  "Changes are saved to the branch's draft (not live yet). Stack more edits with other tools, then run publish_draft once to make everything live (or test first with test_agent).";
