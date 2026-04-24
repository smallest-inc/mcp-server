import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerValidateCoupon(server: McpServer) {
  server.registerTool(
    "validate_coupon",
    {
      description:
        "Check if a coupon code is valid and see how many credits it would give. Does not redeem the coupon — use redeem_coupon to actually apply it.",
      inputSchema: {
        code: z.string().describe("The coupon code to validate"),
      },
    },
    async (params) => {
      const result = await paymentsApi(
        "GET",
        `/coupons/validate?code=${encodeURIComponent(params.code)}`
      );

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
