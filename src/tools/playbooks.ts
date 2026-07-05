import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";
import { apiToolSchema, buildApiCallTool, type ApiToolInput } from "./add-agent-tool.js";

/**
 * Playbooks (multi-agent SOP orchestration) tools.
 *
 * A `multi_agents` agent = an intent router + N "playbooks" (SOPs). Every caller
 * turn is classified to the best-matching playbook, which runs a focused prompt
 * with a scoped tool subset; weak/strong auth levels gate a playbook's tools
 * behind shared identity tools. All edits land on a DRAFT — publish_draft makes
 * them live.
 *
 * Tool set:
 *   get_playbooks       — read the playbooks config (active / draft / version)
 *   add_playbooks       — add one or more SOPs to a draft
 *   update_playbook     — edit / archive / restore one SOP on a draft
 *   configure_playbooks — router, conversation guide, shared auth tools
 */

// ── shared shapes ────────────────────────────────────────────────────────────

interface PlaybookTool {
  type?: string;
  name?: string;
  [key: string]: unknown;
}

interface Playbook {
  id: string;
  name: string;
  intentName: string;
  intentDescription: string;
  enabled?: boolean;
  authLevel?: "none" | "weak" | "strong";
  prompt: string;
  tools?: PlaybookTool[];
  knowledgeBaseId?: string;
}

interface PlaybooksSection {
  router: { fallbackPlaybookId: string; allowMidCallReroute: boolean };
  auth?: { weakTools?: PlaybookTool[]; strongTools?: PlaybookTool[] };
  conversationGuide?: string;
  playbooks: Playbook[];
}

const EMPTY_SECTION: PlaybooksSection = {
  router: { fallbackPlaybookId: "", allowMidCallReroute: true },
  auth: { weakTools: [], strongTools: [] },
  playbooks: [],
};

const AUTH_LEVEL = z
  .enum(["none", "weak", "strong"])
  .describe(
    "Identity proof required before this playbook's own tools may run: none | weak (caller recognition — shared weak auth tools must succeed) | strong (full identity proof — weak AND strong auth tools must succeed). Default none."
  );

/** One SOP as accepted by add_playbooks. */
const playbookInputSchema = z.object({
  name: z.string().min(1).describe("Customer-facing label, e.g. 'Foreclosure Quote & Letter (SOP-06)'. Must be unique on the agent (case-insensitive, including archived playbooks)."),
  intent_name: z
    .string()
    .min(1)
    .describe("Short intent label the classifier routes on, e.g. 'foreclosure'. Unique on the agent (case-insensitive, including archived)."),
  intent_description: z
    .string()
    .min(1)
    .describe("Natural-language description of what routes a caller here — read by the intent classifier. Be specific; include near-miss guidance if intents are similar."),
  prompt: z.string().min(1).describe("The specialist's system prompt: the SOP steps, guardrails, and tone for this intent."),
  auth_level: AUTH_LEVEL.optional(),
  knowledge_base_id: z.string().optional().describe("Optional knowledge base ID scoped to this playbook."),
  enabled: z.boolean().optional().describe("Whether the playbook is active (default true). Disabled playbooks are never routed to."),
  tools: z
    .array(apiToolSchema)
    .optional()
    .describe("API-call tools scoped to this playbook (same shape as add_agent_tool). Do NOT list identity tools here — those are shared, set via configure_playbooks."),
  add_end_call_tool: z
    .boolean()
    .optional()
    .describe("Add an end_call action tool so the agent can hang up from this playbook when the caller is done. Without it (on any playbook) the agent cannot end calls."),
  transfer_call_number: z
    .string()
    .optional()
    .describe("Add a transfer_call action tool that cold-transfers to this number (E.164, e.g. +9198...)."),
});

type PlaybookInput = z.infer<typeof playbookInputSchema>;

// ── helpers ──────────────────────────────────────────────────────────────────

function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "playbook";
  let id = base;
  let i = 2;
  while (taken.has(id)) id = `${base}_${i++}`;
  return id;
}

function buildPlaybookTools(p: PlaybookInput): PlaybookTool[] {
  const tools: PlaybookTool[] = (p.tools ?? []).map((t) => buildApiCallTool(t as ApiToolInput));
  if (p.add_end_call_tool) {
    tools.push({
      type: "end_call",
      name: "end_call",
      description:
        "End the call. Use when the customer says goodbye, confirms they have no more questions, or asks to hang up. Say a short farewell first, then call this.",
      enabled: true,
    });
  }
  if (p.transfer_call_number) {
    tools.push({
      type: "transfer_call",
      name: "transfer_call",
      description: "Transfer the caller to a human agent. Tell the caller you are transferring them first.",
      transferNumber: p.transfer_call_number,
      transferOption: { type: "cold_transfer" },
      onHoldMusic: "none",
      enabled: true,
    });
  }
  return tools;
}

function buildPlaybook(p: PlaybookInput, taken: Set<string>): Playbook {
  return {
    id: slugId(p.intent_name, taken),
    name: p.name,
    intentName: p.intent_name,
    intentDescription: p.intent_description,
    enabled: p.enabled ?? true,
    authLevel: p.auth_level ?? "none",
    prompt: p.prompt,
    tools: buildPlaybookTools(p),
    ...(p.knowledge_base_id && { knowledgeBaseId: p.knowledge_base_id }),
  };
}

type SectionResult =
  | { ok: true; section: PlaybooksSection; agent: any }
  | { ok: false; message: string };

/** Fetch the playbooks section from the agent's resolved config (active / draft / version). */
async function fetchPlaybooksSection(
  agentId: string,
  opts: { draftId?: string; versionId?: string } = {}
): Promise<SectionResult> {
  const qs = opts.draftId
    ? `?draftId=${encodeURIComponent(opts.draftId)}`
    : opts.versionId
      ? `?versionId=${encodeURIComponent(opts.versionId)}`
      : "";
  const result = await atomsApi("GET", `/agent/${encodeURIComponent(agentId)}${qs}`);
  if (!result.ok) {
    if (result.status === 404) return { ok: false, message: `Agent not found: ${agentId}` };
    return { ok: false, message: formatApiError(result) };
  }
  const agent = result.data?.data ?? result.data;
  if (agent?.workflowType !== "multi_agents") {
    return {
      ok: false,
      message: `Agent ${agentId} is a ${agent?.workflowType ?? "unknown"} agent — playbooks only apply to multi_agents agents. Create one with create_agent { workflow_type: "multi_agents" }.`,
    };
  }
  const raw = agent?._resolvedConfig?.playbooks;
  const section: PlaybooksSection = {
    ...EMPTY_SECTION,
    ...(raw ?? {}),
    router: { ...EMPTY_SECTION.router, ...(raw?.router ?? {}) },
    auth: { weakTools: [], strongTools: [], ...(raw?.auth ?? {}) },
    playbooks: raw?.playbooks ?? [],
  };
  return { ok: true, section, agent };
}

type DraftResult = { ok: true; draftId: string; created: boolean } | { ok: false; message: string };

/** Use the given draft, or create a fresh one from the agent's active version. */
async function resolveDraft(agentId: string, draftId: string | undefined, agent: any): Promise<DraftResult> {
  if (draftId) return { ok: true, draftId, created: false };
  const create = await atomsApi("POST", `/agent/${encodeURIComponent(agentId)}/drafts`, {
    sourceVersionId: agent?.activeVersionId,
  });
  if (!create.ok) return { ok: false, message: `Failed to create draft: ${formatApiError(create)}` };
  const draft = create.data?.data ?? create.data;
  if (!draft?.draftId) return { ok: false, message: "Draft creation returned no draftId" };
  return { ok: true, draftId: draft.draftId, created: true };
}

async function savePlaybooks(agentId: string, draftId: string, section: PlaybooksSection) {
  return atomsApi(
    "PATCH",
    `/agent/${encodeURIComponent(agentId)}/drafts/${encodeURIComponent(draftId)}/config`,
    { playbooks: section }
  );
}

/** Case-insensitive duplicate check across ALL playbooks (archived included — the backend enforces the same). */
function findDuplicate(existing: Playbook[], incoming: { name: string; intentName: string }[]): string | null {
  const names = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  const intents = new Set(existing.map((p) => p.intentName.trim().toLowerCase()));
  for (const p of incoming) {
    const n = p.name.trim().toLowerCase();
    const i = p.intentName.trim().toLowerCase();
    if (names.has(n)) return `name "${p.name}" already exists (uniqueness is case-insensitive and includes archived playbooks)`;
    if (intents.has(i)) return `intent_name "${p.intentName}" already exists (uniqueness is case-insensitive and includes archived playbooks)`;
    names.add(n);
    intents.add(i);
  }
  return null;
}

function summarize(section: PlaybooksSection) {
  return {
    router: section.router,
    conversation_guide_chars: (section.conversationGuide ?? "").length,
    auth: {
      weak_tools: (section.auth?.weakTools ?? []).map((t) => t.name),
      strong_tools: (section.auth?.strongTools ?? []).map((t) => t.name),
    },
    playbooks: section.playbooks.map((p) => ({
      id: p.id,
      name: p.name,
      intent: p.intentName,
      auth: p.authLevel ?? "none",
      tools: (p.tools ?? []).length,
      ...(p.enabled === false && { archived: true }),
      ...(p.id === section.router.fallbackPlaybookId && { fallback: true }),
    })),
  };
}

/** Publish-blocking gaps worth surfacing after every edit. */
function publishWarnings(section: PlaybooksSection): string[] {
  const warnings: string[] = [];
  const active = section.playbooks.filter((p) => p.enabled !== false);
  const fallback = section.playbooks.find((p) => p.id === section.router.fallbackPlaybookId);
  if (active.length === 0) warnings.push("No enabled playbooks — publish will fail.");
  if (!fallback || fallback.enabled === false)
    warnings.push("router.fallbackPlaybookId does not point at an enabled playbook — publish will fail. Set it via configure_playbooks.");
  const needsWeak = active.some((p) => (p.authLevel ?? "none") !== "none");
  const needsStrong = active.some((p) => p.authLevel === "strong");
  if (needsWeak && (section.auth?.weakTools ?? []).length === 0)
    warnings.push("A playbook requires weak/strong auth but auth.weakTools is empty — publish will fail. Add identity tools via configure_playbooks weak_auth_tools.");
  if (needsStrong && (section.auth?.strongTools ?? []).length === 0)
    warnings.push("A playbook requires strong auth but auth.strongTools is empty — publish will fail. Add identity tools via configure_playbooks strong_auth_tools.");
  if (!active.some((p) => (p.tools ?? []).some((t) => t.type === "end_call")))
    warnings.push("No playbook has an end_call tool — the agent will have no way to end calls.");
  return warnings;
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function textErr(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

const DRAFT_PARAM = z
  .string()
  .optional()
  .describe(
    "Draft to edit. Omit to start a NEW draft from the active version (its id is returned — pass it to subsequent playbooks calls so all edits land on the same draft). Changes go live only after publish_draft."
  );

// ── get_playbooks ────────────────────────────────────────────────────────────

export function registerGetPlaybooks(server: McpServer) {
  server.registerTool(
    "get_playbooks",
    {
      description:
        "Read a multi_agents agent's Playbooks config: the intent router (fallback + mid-call rerouting), shared auth tools, and the SOP list (id, intent, auth level, tool count). Pass playbook_id for one playbook's full detail (prompt, tools, intent description). Reads the active version by default; pass draft_id or version_id to inspect those instead.",
      inputSchema: {
        agent_id: z.string().describe("The multi_agents agent ID"),
        draft_id: z.string().optional().describe("Read this draft's config instead of the active version"),
        version_id: z.string().optional().describe("Read this published version's config instead of the active version"),
        playbook_id: z.string().optional().describe("Return the full config of just this playbook"),
      },
    },
    async (params) => {
      const fetched = await fetchPlaybooksSection(params.agent_id, {
        draftId: params.draft_id,
        versionId: params.version_id,
      });
      if (!fetched.ok) return textErr(fetched.message);
      if (params.playbook_id) {
        const pb = fetched.section.playbooks.find((p) => p.id === params.playbook_id);
        if (!pb) return textErr(`No playbook with id "${params.playbook_id}". Known ids: ${fetched.section.playbooks.map((p) => p.id).join(", ") || "(none)"}`);
        return text(pb);
      }
      const warnings = publishWarnings(fetched.section);
      return text({ ...summarize(fetched.section), ...(warnings.length > 0 && { warnings }) });
    }
  );
}

// ── add_playbooks ────────────────────────────────────────────────────────────

export function registerAddPlaybooks(server: McpServer) {
  server.registerTool(
    "add_playbooks",
    {
      description:
        "Add one or more playbooks (SOPs) to a multi_agents agent. Each playbook = an intent (name + description the classifier routes on) + a specialist prompt + optional scoped tools and an auth level. Edits land on a draft (auto-created from the active version when draft_id is omitted) — use publish_draft to go live. The first enabled playbook becomes the router fallback automatically if none is set. Names and intent names must be unique on the agent (case-insensitive, archived included).",
      inputSchema: {
        agent_id: z.string().describe("The multi_agents agent ID"),
        draft_id: DRAFT_PARAM,
        playbooks: z.array(playbookInputSchema).min(1).describe("The SOPs to add (batch them — one draft write)"),
      },
    },
    async (params) => {
      const fetched = await fetchPlaybooksSection(params.agent_id, { draftId: params.draft_id });
      if (!fetched.ok) return textErr(fetched.message);
      const section = fetched.section;

      const dup = findDuplicate(
        section.playbooks,
        params.playbooks.map((p) => ({ name: p.name, intentName: p.intent_name }))
      );
      if (dup) return textErr(`Duplicate playbook: ${dup}. Rename it or use update_playbook to edit the existing one.`);

      const taken = new Set(section.playbooks.map((p) => p.id));
      const added: Playbook[] = [];
      for (const p of params.playbooks) {
        const pb = buildPlaybook(p, taken);
        taken.add(pb.id);
        added.push(pb);
      }
      section.playbooks = [...section.playbooks, ...added];

      let fallbackNote: string | undefined;
      if (!section.playbooks.some((p) => p.id === section.router.fallbackPlaybookId && p.enabled !== false)) {
        const firstEnabled = section.playbooks.find((p) => p.enabled !== false);
        if (firstEnabled) {
          section.router.fallbackPlaybookId = firstEnabled.id;
          fallbackNote = `router.fallbackPlaybookId set to "${firstEnabled.id}" (none was set). Change via configure_playbooks.`;
        }
      }

      const draft = await resolveDraft(params.agent_id, params.draft_id, fetched.agent);
      if (!draft.ok) return textErr(draft.message);
      const save = await savePlaybooks(params.agent_id, draft.draftId, section);
      if (!save.ok) return textErr(`Failed to save playbooks: ${formatApiError(save)}`);

      const warnings = publishWarnings(section);
      return text({
        message: `Added ${added.length} playbook(s) to draft`,
        draft_id: draft.draftId,
        ...(draft.created && { draft_created: true }),
        added: added.map((p) => ({ id: p.id, name: p.name, intent: p.intentName, auth: p.authLevel, tools: (p.tools ?? []).length })),
        total_playbooks: section.playbooks.length,
        ...(fallbackNote && { fallback: fallbackNote }),
        ...(warnings.length > 0 && { warnings }),
        hint: "Draft only — publish_draft to go live. Pass this draft_id to further playbooks calls to keep editing the same draft.",
      });
    }
  );
}

// ── update_playbook ──────────────────────────────────────────────────────────

export function registerUpdatePlaybook(server: McpServer) {
  server.registerTool(
    "update_playbook",
    {
      description:
        "Edit one playbook (SOP) on a multi_agents agent: change its prompt, intent, auth level, tools, or archive/restore it (enabled=false/true — playbooks are archived, never deleted, so call history stays resolvable). Edits land on a draft (auto-created when draft_id omitted); publish_draft to go live. The router fallback cannot be archived — repoint it first via configure_playbooks.",
      inputSchema: {
        agent_id: z.string().describe("The multi_agents agent ID"),
        draft_id: DRAFT_PARAM,
        playbook_id: z.string().describe("The playbook id to edit (see get_playbooks)"),
        name: z.string().min(1).optional().describe("New customer-facing label"),
        intent_name: z.string().min(1).optional().describe("New intent label (must stay unique on the agent)"),
        intent_description: z.string().min(1).optional().describe("New intent description for the classifier"),
        prompt: z.string().min(1).optional().describe("New specialist prompt"),
        auth_level: AUTH_LEVEL.optional(),
        knowledge_base_id: z.string().optional().describe("Per-playbook knowledge base ID ('' to clear)"),
        enabled: z.boolean().optional().describe("false = archive (never routed to), true = restore"),
        tools: z
          .array(apiToolSchema)
          .optional()
          .describe("REPLACES the playbook's API-call tools (end_call/transfer_call tools are preserved unless the flags below change them)"),
        add_end_call_tool: z.boolean().optional().describe("true = ensure an end_call tool on this playbook; false = remove it"),
        transfer_call_number: z.string().optional().describe("Set/replace a transfer_call tool to this number ('' to remove)"),
      },
    },
    async (params) => {
      const fetched = await fetchPlaybooksSection(params.agent_id, { draftId: params.draft_id });
      if (!fetched.ok) return textErr(fetched.message);
      const section = fetched.section;

      const pb = section.playbooks.find((p) => p.id === params.playbook_id);
      if (!pb) return textErr(`No playbook with id "${params.playbook_id}". Known ids: ${section.playbooks.map((p) => p.id).join(", ") || "(none)"}`);

      if (params.enabled === false && section.router.fallbackPlaybookId === params.playbook_id) {
        return textErr(
          `Playbook "${params.playbook_id}" is the router fallback — it cannot be archived. Point router.fallbackPlaybookId at another enabled playbook first (configure_playbooks), then archive this one.`
        );
      }

      const renames = [];
      if (params.name !== undefined) renames.push({ name: params.name, intentName: pb.intentName });
      if (params.intent_name !== undefined) renames.push({ name: pb.name, intentName: params.intent_name });
      if (renames.length > 0) {
        const others = section.playbooks.filter((p) => p.id !== pb.id);
        const dup = findDuplicate(others, [
          {
            name: params.name ?? pb.name,
            intentName: params.intent_name ?? pb.intentName,
          },
        ]);
        if (dup) return textErr(`Rename collides: ${dup}.`);
      }

      if (params.name !== undefined) pb.name = params.name;
      if (params.intent_name !== undefined) pb.intentName = params.intent_name;
      if (params.intent_description !== undefined) pb.intentDescription = params.intent_description;
      if (params.prompt !== undefined) pb.prompt = params.prompt;
      if (params.auth_level !== undefined) pb.authLevel = params.auth_level;
      if (params.knowledge_base_id !== undefined) {
        if (params.knowledge_base_id === "") delete pb.knowledgeBaseId;
        else pb.knowledgeBaseId = params.knowledge_base_id;
      }
      if (params.enabled !== undefined) pb.enabled = params.enabled;

      let tools = pb.tools ?? [];
      if (params.tools !== undefined) {
        const kept = tools.filter((t) => t.type === "end_call" || t.type === "transfer_call");
        tools = [...params.tools.map((t) => buildApiCallTool(t as ApiToolInput)), ...kept];
      }
      if (params.add_end_call_tool !== undefined) {
        tools = tools.filter((t) => t.type !== "end_call");
        if (params.add_end_call_tool) {
          tools.push({
            type: "end_call",
            name: "end_call",
            description:
              "End the call. Use when the customer says goodbye, confirms they have no more questions, or asks to hang up. Say a short farewell first, then call this.",
            enabled: true,
          });
        }
      }
      if (params.transfer_call_number !== undefined) {
        tools = tools.filter((t) => t.type !== "transfer_call");
        if (params.transfer_call_number !== "") {
          tools.push({
            type: "transfer_call",
            name: "transfer_call",
            description: "Transfer the caller to a human agent. Tell the caller you are transferring them first.",
            transferNumber: params.transfer_call_number,
            transferOption: { type: "cold_transfer" },
            onHoldMusic: "none",
            enabled: true,
          });
        }
      }
      pb.tools = tools;

      const draft = await resolveDraft(params.agent_id, params.draft_id, fetched.agent);
      if (!draft.ok) return textErr(draft.message);
      const save = await savePlaybooks(params.agent_id, draft.draftId, section);
      if (!save.ok) return textErr(`Failed to save playbooks: ${formatApiError(save)}`);

      const warnings = publishWarnings(section);
      return text({
        message: `Playbook "${pb.id}" updated on draft`,
        draft_id: draft.draftId,
        ...(draft.created && { draft_created: true }),
        playbook: { id: pb.id, name: pb.name, intent: pb.intentName, auth: pb.authLevel, enabled: pb.enabled !== false, tools: (pb.tools ?? []).length },
        ...(warnings.length > 0 && { warnings }),
        hint: "Draft only — publish_draft to go live.",
      });
    }
  );
}

// ── configure_playbooks ──────────────────────────────────────────────────────

export function registerConfigurePlaybooks(server: McpServer) {
  server.registerTool(
    "configure_playbooks",
    {
      description:
        "Configure the section-level Playbooks settings of a multi_agents agent: the intent router (fallback playbook, mid-call rerouting), the conversation guide (persona/tone/global rules injected into EVERY playbook — define them once here, not per-SOP), and the shared identity tools that satisfy weak/strong auth. Edits land on a draft (auto-created when draft_id omitted); publish_draft to go live.",
      inputSchema: {
        agent_id: z.string().describe("The multi_agents agent ID"),
        draft_id: DRAFT_PARAM,
        fallback_playbook_id: z
          .string()
          .optional()
          .describe("Playbook the router uses when no intent matches. Must be an enabled playbook id."),
        allow_mid_call_reroute: z
          .boolean()
          .optional()
          .describe("Let the router switch playbooks mid-call when the caller's intent changes"),
        conversation_guide: z
          .string()
          .optional()
          .describe("Persona + style + global rules injected into every specialist prompt (e.g. 'You are Aria, a warm female support agent; mirror the caller's language; be concise.')"),
        weak_auth_tools: z
          .array(apiToolSchema)
          .optional()
          .describe("REPLACES the shared weak-auth (caller recognition) tools, e.g. identify_by_phone. Required (non-empty) if any playbook uses auth_level weak or strong."),
        strong_auth_tools: z
          .array(apiToolSchema)
          .optional()
          .describe("REPLACES the shared strong-auth (full identity proof) tools, e.g. verify_dob. Required (non-empty) if any playbook uses auth_level strong."),
      },
    },
    async (params) => {
      const fetched = await fetchPlaybooksSection(params.agent_id, { draftId: params.draft_id });
      if (!fetched.ok) return textErr(fetched.message);
      const section = fetched.section;

      const changed: string[] = [];
      if (params.fallback_playbook_id !== undefined) {
        const target = section.playbooks.find((p) => p.id === params.fallback_playbook_id);
        if (!target)
          return textErr(`No playbook with id "${params.fallback_playbook_id}". Known ids: ${section.playbooks.map((p) => p.id).join(", ") || "(none)"}`);
        if (target.enabled === false)
          return textErr(`Playbook "${params.fallback_playbook_id}" is archived — the fallback must be an enabled playbook. Restore it first (update_playbook enabled=true).`);
        section.router.fallbackPlaybookId = params.fallback_playbook_id;
        changed.push("router.fallbackPlaybookId");
      }
      if (params.allow_mid_call_reroute !== undefined) {
        section.router.allowMidCallReroute = params.allow_mid_call_reroute;
        changed.push("router.allowMidCallReroute");
      }
      if (params.conversation_guide !== undefined) {
        section.conversationGuide = params.conversation_guide;
        changed.push("conversationGuide");
      }
      if (params.weak_auth_tools !== undefined) {
        section.auth = { ...(section.auth ?? {}), weakTools: params.weak_auth_tools.map((t) => buildApiCallTool(t as ApiToolInput)) };
        changed.push("auth.weakTools");
      }
      if (params.strong_auth_tools !== undefined) {
        section.auth = { ...(section.auth ?? {}), strongTools: params.strong_auth_tools.map((t) => buildApiCallTool(t as ApiToolInput)) };
        changed.push("auth.strongTools");
      }
      if (changed.length === 0) return textErr("Nothing to change — pass at least one setting.");

      const draft = await resolveDraft(params.agent_id, params.draft_id, fetched.agent);
      if (!draft.ok) return textErr(draft.message);
      const save = await savePlaybooks(params.agent_id, draft.draftId, section);
      if (!save.ok) return textErr(`Failed to save playbooks: ${formatApiError(save)}`);

      const warnings = publishWarnings(section);
      return text({
        message: `Updated: ${changed.join(", ")}`,
        draft_id: draft.draftId,
        ...(draft.created && { draft_created: true }),
        ...(warnings.length > 0 && { warnings }),
        hint: "Draft only — publish_draft to go live.",
      });
    }
  );
}
