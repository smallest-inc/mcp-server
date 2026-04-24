import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetBillingAlerts(server: McpServer) {
  server.registerTool(
    "get_billing_alerts",
    {
      description:
        "Get the current billing alert configuration for your organization. Billing alerts notify you when credit usage reaches specified thresholds.",
      inputSchema: {},
    },
    async () => {
      const result = await paymentsApi("GET", "/billing-alerts");

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
