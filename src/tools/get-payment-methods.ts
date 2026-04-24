import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetPaymentMethods(server: McpServer) {
  server.registerTool(
    "get_payment_methods",
    {
      description:
        "List all payment methods (cards) configured for your organization. Shows card brand, last 4 digits, expiry, and which is the default.",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/payment-methods");

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
