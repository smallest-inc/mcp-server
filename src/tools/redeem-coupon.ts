import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerRedeemCoupon(server: McpServer) {
  server.registerTool(
    "redeem_coupon",
    {
      description:
        "Redeem a coupon code to add credits to your organization's balance. Use validate_coupon first to check the code before redeeming.",
      inputSchema: {
        code: z.string().describe("The coupon code to redeem"),
      },
    },
    async (params) => {
      const result = await paymentsApi("POST", "/coupons/redeem", { code: params.code });

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
                message: "Coupon redeemed successfully!",
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
