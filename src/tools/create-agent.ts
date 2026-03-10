import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerCreateAgent(server: McpServer) {
  server.registerTool(
    "create_agent",
    {
      description:
        "Create a new AI agent in your organization. The agent is created as a single_prompt agent with gpt-4.1 model and rachel voice by default. Returns the created agent's ID. Set the agent prompt via update_agent_prompt after creation.",
      inputSchema: {
        name: z.string().optional().describe("Name for the new agent"),
        description: z.string().optional().describe("Short description of what the agent does"),
        language: z
          .string()
          .default("en")
          .describe("Default language code (e.g. en, hi, ta). Defaults to en."),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {
        workflowType: "single_prompt",
        language: {
          default: params.language,
          supported: [params.language],
          switching: { isEnabled: false },
        },
      };

      if (params.name !== undefined) body.name = params.name;
      if (params.description !== undefined) body.description = params.description;

      const result = await atomsApi("POST", "/agent", body);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const agentId = result.data?.data ?? result.data;

      // Immediately update config to set gpt-4.1 model and rachel voice
      const configResult = await atomsApi("PATCH", `/agent/${encodeURIComponent(agentId)}`, {
        slmModel: "gpt-4.1",
        synthesizer: {
          voiceConfig: {
            model: "waves_lightning_large",
            voiceId: "rachel",
          },
          speed: 1.2,
        },
      });

      const warnings: string[] = [];
      if (!configResult.ok) {
        warnings.push(
          `Agent created but failed to set default model/voice: ${formatApiError(configResult)}. Use update_agent_config to set them manually.`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Agent created successfully",
                agentId,
                defaults_applied: {
                  workflowType: "single_prompt",
                  slmModel: "gpt-4.1",
                  voice: "rachel (waves_lightning_large)",
                },
                ...(warnings.length > 0 && { warnings }),
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
