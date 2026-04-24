import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetUsageBreakdown(server: McpServer) {
  server.registerTool(
    "get_usage_breakdown",
    {
      description:
        "Get a breakdown of credit usage by feature and product scope for your organization. Shows how credits are being consumed across different services (voice AI, voice models, platform).",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/credits/usage/breakdown");

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatPaymentsApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

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
