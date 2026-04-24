import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetAutoReload(server: McpServer) {
  server.registerTool(
    "get_auto_reload",
    {
      description:
        "Get the current auto-reload configuration for your organization. Auto-reload automatically adds credits when your balance drops below a threshold.",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/auto-reload");

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatPaymentsApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      if (!data) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Auto-reload is not configured for this organization.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
