import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchAgentAndTools, persistAgentTools, DRAFT_HINT } from "./agent-tools-helper.js";

/**
 * Agent-LEVEL call actions — end_call and transfer_call. These live in the
 * agent's Tools section (the console's Tools tab), shared by single_prompt and
 * multi_agents workflows alike; for multi-agents the runtime injects them into
 * every playbook, ungated. They are NEVER configured per playbook.
 */
export function registerConfigureCallActions(server: McpServer) {
  server.registerTool(
    "configure_call_actions",
    {
      description:
        "Enable/disable the agent's end_call action and set/remove a transfer_call number. These are AGENT-LEVEL settings (the console's Tools tab) that apply to the whole agent — for multi-agent (Playbooks) agents the runtime injects them into every playbook, never gated behind auth. Changes land on the branch's draft; publish_draft to go live. Without an enabled end_call the agent cannot hang up on its own.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        branch_id: z
          .string()
          .optional()
          .describe("Branch whose draft to edit (from list_branches). Omit to use the live branch; if the agent has multiple branches you'll be asked to pick one."),
        end_call: z
          .boolean()
          .optional()
          .describe("true = enable the end_call action; false = remove it"),
        end_call_description: z
          .string()
          .optional()
          .describe("Optional guidance for WHEN to end the call (used with end_call: true)"),
        transfer_call_number: z
          .string()
          .optional()
          .describe("Cold-transfer destination in E.164 (e.g. +9198...). '' removes the transfer_call action."),
      },
    },
    async (params) => {
      if (params.end_call === undefined && params.transfer_call_number === undefined) {
        return {
          content: [
            { type: "text" as const, text: "Provide end_call and/or transfer_call_number — nothing to change." },
          ],
        };
      }

      // Draft-aware read of the current agent-level tools (preserves api_call tools).
      const fetched = await fetchAgentAndTools(params.agent_id, params.branch_id);
      if (!fetched.ok) {
        return { content: [{ type: "text" as const, text: fetched.message }] };
      }

      let tools: any[] = [...fetched.tools];

      if (params.end_call !== undefined) {
        tools = tools.filter((t) => t?.type !== "end_call");
        if (params.end_call) {
          tools.push({
            type: "end_call",
            name: "end_call",
            description:
              params.end_call_description ??
              "End the call. Use when the customer says goodbye, confirms they have no more questions, or asks to hang up. Say a short farewell first, then call this.",
            enabled: true,
          });
        }
      }

      if (params.transfer_call_number !== undefined) {
        tools = tools.filter((t) => t?.type !== "transfer_call");
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

      const persisted = await persistAgentTools(fetched.agent, fetched.branchId, tools);
      if (!persisted.ok) {
        return { content: [{ type: "text" as const, text: persisted.message }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Call actions saved to draft.",
                agentId: params.agent_id,
                end_call: tools.some((t) => t?.type === "end_call" && t?.enabled !== false),
                transfer_call:
                  tools.find((t) => t?.type === "transfer_call" && t?.enabled !== false)?.transferNumber ?? null,
                other_tools: tools.filter((t) => t?.type !== "end_call" && t?.type !== "transfer_call").length,
                status: "draft",
                hint: DRAFT_HINT,
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
