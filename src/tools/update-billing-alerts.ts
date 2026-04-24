import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerUpdateBillingAlerts(server: McpServer) {
  server.registerTool(
    "update_billing_alerts",
    {
      description:
        "Configure billing alert settings. Set up to 3 credit usage thresholds that trigger email notifications. Alerts can be sent to additional email addresses beyond the account owner.",
      inputSchema: {
        is_enabled: z.boolean().describe("Enable or disable billing alerts"),
        thresholds: z
          .array(z.number())
          .max(3)
          .describe("Up to 3 unique credit usage thresholds that trigger alerts (e.g. [10, 50, 100])"),
        additional_emails: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("Up to 10 additional email addresses to receive alerts"),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {
        isEnabled: params.is_enabled,
        thresholds: params.thresholds,
      };
      if (params.additional_emails !== undefined) {
        body.additionalEmails = params.additional_emails;
      }

      const result = await paymentsApi("PUT", "/billing-alerts", body);

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatPaymentsApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Billing alerts updated.",
                ...data,
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
