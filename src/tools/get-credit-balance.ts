import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetCreditBalance(server: McpServer) {
  server.registerTool(
    "get_credit_balance",
    {
      description:
        "Get the current credit balance for your organization, including plan information and enterprise status.",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/credits/balance");

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
