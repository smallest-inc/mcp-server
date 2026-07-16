import { atomsApi, formatApiError } from "./api.js";

/**
 * Agent versioning v2 (branch model) client helpers.
 *
 * An agent has BRANCHES; each branch has a series of committed revisions
 * (head = live if it's the live branch) and at most one open draft (unnamed —
 * present or not). Edits go to a branch's draft; publishing commits a new
 * revision. The live branch is the one that serves traffic.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll cadence for the async security scan on publish (~60s total). */
const SCAN_POLL_INTERVAL_MS = 4000;
const SCAN_MAX_POLLS = 15;

export type BranchResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface Branch {
  branchId: string;
  name: string | null;
  isLive: boolean;
  hasOpenDraft: boolean;
  openDraftId: string | null;
  headRevisionId: string | null;
}

/** Map a BranchSummary ({ branch, isLive, hasOpenDraft, ... }) to our Branch shape. */
function toBranch(summary: any): Branch {
  return {
    branchId: summary.branch?._id,
    name: summary.branch?.name ?? null,
    isLive: !!summary.isLive,
    hasOpenDraft: !!summary.hasOpenDraft,
    openDraftId: (summary.branch?.openDraftId as string | null) ?? null,
    headRevisionId: (summary.branch?.headRevisionId as string | null) ?? null,
  };
}

async function fetchBranches(agentId: string): Promise<BranchResult<Branch[]>> {
  const res = await atomsApi("GET", `/agent/${encodeURIComponent(agentId)}/branches`);
  if (!res.ok) {
    if (res.status === 404) return { ok: false, message: `Agent not found: ${agentId}` };
    return { ok: false, message: formatApiError(res) };
  }
  const data = res.data?.data ?? res.data;
  const summaries: any[] = Array.isArray(data?.branches) ? data.branches : [];
  const branches = summaries.map(toBranch).filter((b) => b.branchId);
  return { ok: true, value: branches };
}

/** The live (serving) branch. Used where "live" is always correct (e.g. make_call). */
export async function resolveLiveBranch(agentId: string): Promise<BranchResult<Branch>> {
  const res = await fetchBranches(agentId);
  if (!res.ok) return res;
  const live = res.value.find((b) => b.isLive);
  if (!live) {
    return {
      ok: false,
      message: `No live branch found for agent ${agentId} — it may not be migrated to the branch model yet.`,
    };
  }
  return { ok: true, value: live };
}

/**
 * Resolve the branch to operate on:
 * - branchId given → that branch (error if it doesn't exist)
 * - omitted + a single branch → that branch (no ambiguity)
 * - omitted + multiple branches → ask the user which one (returns an actionable error)
 */
export async function resolveBranch(agentId: string, branchId?: string): Promise<BranchResult<Branch>> {
  const res = await fetchBranches(agentId);
  if (!res.ok) return res;
  const branches = res.value;

  if (branchId) {
    const match = branches.find((b) => b.branchId === branchId);
    if (!match) {
      return { ok: false, message: `Branch not found: ${branchId}. Use list_branches to see this agent's branches.` };
    }
    return { ok: true, value: match };
  }

  if (branches.length > 1) {
    const list = branches
      .map((b) => `- ${b.name} (branch_id: ${b.branchId})${b.isLive ? " [live]" : ""}${b.hasOpenDraft ? " [has draft]" : ""}`)
      .join("\n");
    return {
      ok: false,
      message: `This agent has multiple branches — ask the user which one to use, then retry with branch_id:\n${list}`,
    };
  }

  const only = branches.find((b) => b.isLive) ?? branches[0];
  if (!only) {
    return { ok: false, message: `No branch found for agent ${agentId} — it may not be migrated to the branch model yet.` };
  }
  return { ok: true, value: only };
}

/**
 * Save a config payload onto a branch's draft (auto-opens the draft). `payload`
 * is the same UI-shaped agent config the console uses: { singlePromptConfig:
 * { prompt, tools }, preCallAPI, playbooks, synthesizer, firstMessage, ... }.
 */
export async function saveConfigToBranch(
  agentId: string,
  branchId: string,
  payload: Record<string, unknown>
): Promise<BranchResult<{ branchId: string }>> {
  const res = await atomsApi(
    "PUT",
    `/agent/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branchId)}/draft`,
    payload
  );
  if (!res.ok) return { ok: false, message: formatApiError(res) };
  return { ok: true, value: { branchId } };
}

export type ScanState = "committed" | "scanning" | "failed";

export interface PublishOutcome {
  branchId: string;
  isLive: boolean;
  state: ScanState;
  revisionId?: string;
  revisionNumber?: number;
  reason?: string | null;
}

/**
 * Publish a branch's open draft and wait for the async security scan.
 * Publish returns 200 { state: "committed", revision } (already-passed / graph)
 * or 202 { state: "scanning" }; on scanning we poll until it commits or fails.
 */
export async function publishBranch(
  agentId: string,
  branch: Branch,
  opts: { label?: string } = {}
): Promise<BranchResult<PublishOutcome>> {
  // `label` is forward-compatible: wired up by the publish-label backend change; ignored until then.
  const body: Record<string, unknown> = {};
  if (opts.label !== undefined) body.label = opts.label;

  const res = await atomsApi(
    "POST",
    `/agent/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branch.branchId)}/draft/publish`,
    body
  );
  if (!res.ok) return { ok: false, message: formatApiError(res) };

  const settled = await settleScan(agentId, branch, res.data);
  return { ok: true, value: { ...settled, isLive: branch.isLive } };
}

/** Read the publish result envelope; poll the draft if a scan is still running. */
async function settleScan(
  agentId: string,
  branch: Branch,
  envelope: any
): Promise<Omit<PublishOutcome, "isLive">> {
  const data = envelope?.data ?? envelope;
  if (data?.state === "committed") {
    return {
      branchId: branch.branchId,
      state: "committed",
      revisionId: data?.revision?._id,
      revisionNumber: data?.revision?.revisionNumber ?? data?.revision?.versionNumber,
    };
  }
  return pollScan(agentId, branch);
}

/** Fetch a single branch's current head revision id (or null). */
async function fetchBranchHead(agentId: string, branchId: string): Promise<string | null> {
  const res = await atomsApi(
    "GET",
    `/agent/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branchId)}`
  );
  if (!res.ok) return null;
  const data = res.data?.data ?? res.data;
  return (data?.branch?.headRevisionId as string | null) ?? null;
}

/**
 * Poll a scanning publish. Once the scan passes, reconcile commits and closes the
 * draft (draft detail 404s); a failed scan leaves the draft open with
 * securityCheck.status === "failed". A 404 alone isn't proof of commit (it could
 * be a concurrently-discarded draft or eventual consistency), so on 404 we confirm
 * the branch head actually advanced past the pre-publish head before reporting
 * "committed"; otherwise we keep polling.
 */
async function pollScan(agentId: string, branch: Branch): Promise<Omit<PublishOutcome, "isLive">> {
  const branchId = branch.branchId;
  const priorHead = branch.headRevisionId;
  const draftPath = `/agent/${encodeURIComponent(agentId)}/branches/${encodeURIComponent(branchId)}/draft`;

  for (let polls = 0; polls < SCAN_MAX_POLLS; polls++) {
    await sleep(SCAN_POLL_INTERVAL_MS);

    const detail = await atomsApi("GET", draftPath);

    if (detail.status === 404) {
      // Draft closed — confirm a new revision actually landed (head advanced).
      const head = await fetchBranchHead(agentId, branchId);
      if (head && head !== priorHead) {
        return { branchId, state: "committed", revisionId: head };
      }
      continue; // head unchanged → discarded/eventual consistency; keep polling.
    }
    if (!detail.ok) continue;

    const latest = (detail.data?.data ?? detail.data)?.latest;
    const status: string | undefined = latest?.securityCheck?.status;
    if (status === "failed" || status === "errored") {
      return { branchId, state: "failed", reason: latest?.securityCheck?.reason ?? null };
    }
  }

  return { branchId, state: "scanning" };
}
