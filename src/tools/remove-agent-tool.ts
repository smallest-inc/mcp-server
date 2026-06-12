import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fetchAgentAndTools, persistAgentTools, VERSIONED_DRAFT_HINT } from "./agent-tools-helper.js";

export function registerRemoveAgentTool(server: McpServer) {
  server.registerTool(
    "remove_agent_tool",
    {
      description:
        "Remove a tool (by name) from a single_prompt agent. Works for any tool type (api_call, transfer_call, etc.). " +
        "For versioned agents the change is saved as a draft — use publish_draft to make it live. Use get_agent_prompt to see the agent's current tool names.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID to remove the tool from"),
        name: z.string().min(1).describe("The exact name of the tool to remove"),
      },
    },
    async (params) => {
      const fetched = await fetchAgentAndTools(params.agent_id);
      if (!fetched.ok) {
        return { content: [{ type: "text" as const, text: fetched.message }] };
      }

      const tools = fetched.tools.filter((t) => t?.name !== params.name);
      if (tools.length === fetched.tools.length) {
        const names = fetched.tools.map((t) => t?.name).filter(Boolean);
        return {
          content: [
            {
              type: "text" as const,
              text: `No tool named '${params.name}' on agent ${params.agent_id}.${
                names.length > 0 ? ` Existing tools: ${names.join(", ")}.` : " The agent has no tools."
              }`,
            },
          ],
        };
      }

      const persisted = await persistAgentTools(fetched.agent, fetched.prompt, tools);
      if (!persisted.ok) {
        return { content: [{ type: "text" as const, text: persisted.message }] };
      }

      const result: Record<string, unknown> = {
        message: `Tool '${params.name}' removed (${tools.length} tool${tools.length === 1 ? "" : "s"} remaining).`,
        agentId: params.agent_id,
        totalTools: tools.length,
      };
      if (persisted.versioned) {
        result.versioned = true;
        result.draftId = persisted.draftId;
        result.status = "draft";
        result.hint = VERSIONED_DRAFT_HINT;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
