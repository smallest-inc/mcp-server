import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetCreditLedger(server: McpServer) {
  server.registerTool(
    "get_credit_ledger",
    {
      description:
        "Get the credit transaction history (ledger) for your organization. Shows purchases, usage deductions, bonuses, admin adjustments, coupon credits, and more. Supports filtering by date range, transaction type, and scope.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max entries to return (default 50)"),
        offset: z.number().int().min(0).optional().describe("Offset for pagination (default 0)"),
        from: z
          .string()
          .optional()
          .describe("Start date filter (ISO 8601, e.g. '2025-01-01')"),
        to: z
          .string()
          .optional()
          .describe("End date filter (ISO 8601, e.g. '2025-01-31')"),
        type: z
          .enum([
            "SIGNUP_BONUS",
            "CREDIT_PURCHASE",
            "AUTO_RELOAD",
            "USAGE_DEDUCTION",
            "ADMIN_ADJUSTMENT",
            "COUPON_CREDIT",
            "MIGRATION",
          ])
          .optional()
          .describe("Filter by transaction type"),
        scope: z
          .enum(["platform", "voice_ai", "voice_models"])
          .optional()
          .describe("Filter by product scope"),
      },
    },
    async (params) => {
      const queryParts: string[] = [];
      if (params.limit !== undefined) queryParts.push(`limit=${params.limit}`);
      if (params.offset !== undefined) queryParts.push(`offset=${params.offset}`);
      if (params.from) queryParts.push(`from=${encodeURIComponent(params.from)}`);
      if (params.to) queryParts.push(`to=${encodeURIComponent(params.to)}`);
      if (params.type) queryParts.push(`type=${encodeURIComponent(params.type)}`);
      if (params.scope) queryParts.push(`scope=${encodeURIComponent(params.scope)}`);
      const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

      const result = await paymentsApi("GET", `/credits/ledger${query}`);

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
