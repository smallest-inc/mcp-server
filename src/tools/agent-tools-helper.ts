import { atomsApi, formatApiError } from "../api.js";
import type { IAgentDTO } from "../types.js";

/**
 * Shared helpers for managing an agent's single_prompt tools (functions),
 * e.g. API-call tools. Mirrors how update_agent_prompt reads/writes the
 * workflow so tools and prompt are kept consistent.
 */

export type FetchToolsResult =
  | { ok: true; agent: IAgentDTO; prompt: string | null; tools: any[] }
  | { ok: false; message: string };

/**
 * Fetch the agent plus its current single_prompt prompt and tools array.
 * Blocks conversation-flow (workflow_graph) agents.
 */
export async function fetchAgentAndTools(agentId: string): Promise<FetchToolsResult> {
  const agentResult = await atomsApi("GET", `/agent/${encodeURIComponent(agentId)}`);
  if (!agentResult.ok) {
    if (agentResult.status === 404) return { ok: false, message: `Agent not found: ${agentId}` };
    return { ok: false, message: formatApiError(agentResult) };
  }

  const agent = (agentResult.data?.data ?? agentResult.data) as IAgentDTO;

  if (agent.workflowType === "workflow_graph") {
    return {
      ok: false,
      message:
        "Smallest MCP does not support conversation flow (workflow_graph) agents. Tools can only be managed on single_prompt agents.",
    };
  }

  const workflowResult = await atomsApi("GET", `/agent/${encodeURIComponent(agentId)}/workflow`);
  if (!workflowResult.ok) {
    return { ok: false, message: `Failed to fetch workflow: ${formatApiError(workflowResult)}` };
  }

  const workflow = workflowResult.data?.data ?? workflowResult.data;
  // The prompt/tools can be returned in a few shapes (see get_agent_prompt).
  const src = workflow?.data?.singlePromptConfig ?? workflow?.singlePromptConfig ?? workflow;
  const tools = (src?.tools ?? []) as any[];
  const prompt = (src?.prompt ?? null) as string | null;

  return { ok: true, agent, prompt, tools };
}

export type PersistToolsResult =
  | { ok: true; versioned: boolean; draftId?: string }
  | { ok: false; message: string };

/**
 * Resolve the draft to write into: reuse the caller-supplied draft (edits stack
 * as new revisions of that draft) or create a fresh one from the active version.
 */
async function resolveTargetDraft(
  agentId: string,
  activeVersionId: string,
  existingDraftId?: string
): Promise<{ ok: true; draftId: string } | { ok: false; message: string }> {
  if (existingDraftId) {
    return { ok: true, draftId: existingDraftId };
  }

  const createDraftResult = await atomsApi("POST", `/agent/${encodeURIComponent(agentId)}/drafts`, {
    sourceVersionId: activeVersionId,
  });
  if (!createDraftResult.ok) {
    return { ok: false, message: `Failed to create draft: ${formatApiError(createDraftResult)}` };
  }

  const draft = createDraftResult.data?.data ?? createDraftResult.data;
  const draftId = draft?.draftId as string | undefined;
  if (!draftId) {
    return { ok: false, message: "Draft created but no draftId returned by the API." };
  }
  return { ok: true, draftId };
}

/**
 * Persist the full tools array on an agent.
 *
 * - Versioned agent (has activeVersionId): writes the tools to a draft's
 *   workflow_tools section — an existing draft when `draftId` is given
 *   (stacking a new revision onto it), else a fresh draft from the active
 *   version. The prompt lives in a separate section and is left untouched.
 *   Caller must publish_draft to go live.
 * - Non-versioned agent: replaces the workflow's tools directly (the prompt is
 *   re-sent unchanged because the workflow update requires a non-empty prompt).
 *
 * The tools array is always sent in full — the backend replaces the array
 * wholesale (deepMerge does not merge arrays), so the caller is responsible
 * for upserting/removing within the array before calling this.
 */
export async function persistAgentTools(
  agent: IAgentDTO,
  prompt: string | null,
  tools: any[],
  draftId?: string
): Promise<PersistToolsResult> {
  const agentId = agent._id;

  if (agent.activeVersionId) {
    const target = await resolveTargetDraft(agentId, agent.activeVersionId, draftId);
    if (!target.ok) return target;

    const updateDraftResult = await atomsApi(
      "PATCH",
      `/agent/${encodeURIComponent(agentId)}/drafts/${encodeURIComponent(target.draftId)}/config`,
      { singlePromptConfig: { tools } }
    );
    if (!updateDraftResult.ok) {
      return {
        ok: false,
        message: `Failed to save tools to draft ${target.draftId}: ${formatApiError(updateDraftResult)}`,
      };
    }

    return { ok: true, versioned: true, draftId: target.draftId };
  }

  // Non-versioned: full workflow replace. The workflow schema requires a
  // non-empty prompt, so we must have one to preserve.
  if (!agent.workflowId) {
    return { ok: false, message: `Agent ${agentId} has no workflow associated. Cannot update tools.` };
  }
  if (!prompt || prompt.trim().length === 0) {
    return {
      ok: false,
      message:
        "This agent has no system prompt yet. Set one with update_agent_prompt before adding tools (the workflow requires a non-empty prompt).",
    };
  }

  const result = await atomsApi("PATCH", `/workflow/${encodeURIComponent(agent.workflowId)}`, {
    type: "single_prompt",
    singlePromptConfig: { prompt, tools },
  });
  if (!result.ok) {
    return { ok: false, message: formatApiError(result) };
  }

  return { ok: true, versioned: false };
}

/**
 * Persist a flat agent-config payload (e.g. `{ preCallAPI: {...} }`).
 *
 * - Versioned agent: writes the payload to a draft's config via
 *   PATCH /agent/:id/drafts/:draftId/config — an existing draft when `draftId`
 *   is given (stacking a new revision onto it), else a fresh draft from the
 *   active version. Caller must publish_draft.
 * - Non-versioned agent: PATCH /agent/:id directly.
 *
 * This mirrors how update_agent_config routes config-field changes.
 */
export async function persistAgentConfig(
  agent: IAgentDTO,
  payload: Record<string, unknown>,
  draftId?: string
): Promise<PersistToolsResult> {
  const agentId = agent._id;

  if (agent.activeVersionId) {
    const target = await resolveTargetDraft(agentId, agent.activeVersionId, draftId);
    if (!target.ok) return target;

    const updateDraftResult = await atomsApi(
      "PATCH",
      `/agent/${encodeURIComponent(agentId)}/drafts/${encodeURIComponent(target.draftId)}/config`,
      payload
    );
    if (!updateDraftResult.ok) {
      return {
        ok: false,
        message: `Failed to save config to draft ${target.draftId}: ${formatApiError(updateDraftResult)}`,
      };
    }

    return { ok: true, versioned: true, draftId: target.draftId };
  }

  const result = await atomsApi("PATCH", `/agent/${encodeURIComponent(agentId)}`, payload);
  if (!result.ok) {
    return { ok: false, message: formatApiError(result) };
  }
  return { ok: true, versioned: false };
}

/** Standard hint appended when changes land in a draft (versioned agents). */
export const VERSIONED_DRAFT_HINT =
  "Changes are in draft state (not live yet). Pass this draftId as draft_id to other edit tools to stack more changes into the same draft, then publish_draft once to make everything live (or make_call with the draft's version_id to test first).";
