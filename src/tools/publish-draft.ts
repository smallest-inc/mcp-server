import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for the async security check before giving up (~60s). */
const SECURITY_CHECK_POLL_INTERVAL_MS = 4000;
const SECURITY_CHECK_MAX_POLLS = 15;

export function registerPublishDraft(server: McpServer) {
  server.registerTool(
    "publish_draft",
    {
      description:
        "Publish a draft as a new version and (by default) activate it to make it live. " +
        "Publishing triggers an async security check on the prompt; this tool waits for it to pass before activating and reports the real outcome — " +
        "if the check is still pending after ~60s the version is published but NOT live yet (use activate_version once it passes), and if it fails the version cannot be activated until the prompt is fixed. " +
        "Can also discard a draft instead of publishing.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        draft_id: z.string().describe("The draft ID to publish (returned by update_agent_config, update_agent_prompt, add_agent_tool, set_pre_call_api, etc.)"),
        action: z
          .enum(["publish", "discard"])
          .default("publish")
          .describe("Whether to publish the draft (make it live) or discard it"),
        activate: z
          .boolean()
          .default(true)
          .describe(
            "Activate the published version once its security check passes (default true). Pass false to publish only — activate later with activate_version."
          ),
        label: z
          .string()
          .optional()
          .describe("Version label (max 200 chars, e.g. 'Changed voice to yuvika')"),
        description: z
          .string()
          .optional()
          .describe("Changelog description (max 2000 chars)"),
      },
    },
    async (params) => {
      const agentPath = `/agent/${encodeURIComponent(params.agent_id)}`;
      const draftPath = `${agentPath}/drafts/${encodeURIComponent(params.draft_id)}`;

      if (params.action === "discard") {
        const result = await atomsApi("DELETE", draftPath);

        if (!result.ok) {
          return { content: [{ type: "text" as const, text: formatApiError(result) }] };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Draft ${params.draft_id} discarded. No changes were applied to the live agent.`,
            },
          ],
        };
      }

      // ── Step 1: publish (the backend always publishes INACTIVE and kicks off
      // an async security check on the prompt; activation is a separate step). ──
      const publishBody: Record<string, unknown> = {};
      if (params.label !== undefined) publishBody.label = params.label;
      if (params.description !== undefined) publishBody.description = params.description;

      const result = await atomsApi("POST", `${draftPath}/publish`, publishBody);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const version = result.data?.data ?? result.data;
      const versionId: string | undefined = version?._id;
      const versionNumber: number | undefined = version?.versionNumber;

      const published = {
        agentId: params.agent_id,
        versionId,
        versionNumber,
        label: params.label ?? null,
      };

      if (!params.activate) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message:
                    "Draft published as a new version (NOT active). Activate it with activate_version once its security check passes.",
                  ...published,
                  active: false,
                  securityCheck: version?.securityCheck?.status ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!versionId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message:
                    "Draft published, but the API returned no version id — cannot activate automatically. Use list_versions + activate_version to make it live.",
                  ...published,
                  active: false,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const versionPath = `${agentPath}/versions/${encodeURIComponent(versionId)}`;

      // ── Step 2: wait for the async security check (workflow_graph agents have
      // securityCheck = null and can be activated immediately). ──
      let checkStatus: string | null = version?.securityCheck?.status ?? null;
      let checkReason: string | null = version?.securityCheck?.reason ?? null;

      let polls = 0;
      while (checkStatus === "pending" && polls < SECURITY_CHECK_MAX_POLLS) {
        await sleep(SECURITY_CHECK_POLL_INTERVAL_MS);
        polls += 1;

        const detail = await atomsApi("GET", versionPath);
        if (!detail.ok) break; // fall through to an activation attempt; it will surface the real error

        const detailData = detail.data?.data ?? detail.data;
        const v = detailData?.version ?? detailData;
        checkStatus = v?.securityCheck?.status ?? null;
        checkReason = v?.securityCheck?.reason ?? null;
      }

      if (checkStatus === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message:
                    "Draft published, but the prompt FAILED the security check — the version cannot be activated. Fix the prompt and republish.",
                  ...published,
                  active: false,
                  securityCheck: "failed",
                  reason: checkReason,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (checkStatus === "pending") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message: `Draft published as version ${versionNumber}, but its security check is still pending after ${Math.round((SECURITY_CHECK_POLL_INTERVAL_MS * SECURITY_CHECK_MAX_POLLS) / 1000)}s — the version is NOT live yet. Re-run activate_version(version_id) in a moment to make it live.`,
                  ...published,
                  active: false,
                  securityCheck: "pending",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ── Step 3: activate (security check passed, or not applicable). ──
      const activateResult = await atomsApi("PATCH", `${versionPath}/activate`);

      if (!activateResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  message: `Draft published as version ${versionNumber}, but activation failed — the version is NOT live. ${formatApiError(activateResult)}`,
                  ...published,
                  active: false,
                  securityCheck: checkStatus,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Draft published and activated. Changes are now live.",
                ...published,
                active: true,
                securityCheck: checkStatus ?? "not_applicable",
                ...(polls > 0 && { securityCheckWaitSecs: (polls * SECURITY_CHECK_POLL_INTERVAL_MS) / 1000 }),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
