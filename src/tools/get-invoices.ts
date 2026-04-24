import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetInvoices(server: McpServer) {
  server.registerTool(
    "get_invoices",
    {
      description:
        "List all invoices for your organization from Stripe. Shows invoice details including amounts, status, and dates.",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/invoices");

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
