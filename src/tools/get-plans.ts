import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetPlans(server: McpServer) {
  server.registerTool(
    "get_plans",
    {
      description:
        "List available plans and optionally get the features included in a specific plan. Use this to understand plan pricing, included features, and credit rates.",
      inputSchema: {
        plan_id: z
          .string()
          .optional()
          .describe("If provided, also returns the features for this specific plan"),
      },
    },
    async (params) => {
      const plansResult = await paymentsApi("GET", "/plans");

      if (!plansResult.ok) {
        return { content: [{ type: "text" as const, text: formatPaymentsApiError(plansResult) }] };
      }

      const plans = plansResult.data?.data ?? plansResult.data;

      if (!params.plan_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(plans, null, 2),
            },
          ],
        };
      }

      // Also fetch features for the specified plan
      const featuresResult = await paymentsApi(
        "GET",
        `/plans/${encodeURIComponent(params.plan_id)}/features`
      );

      if (!featuresResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  plans,
                  planFeaturesError: formatPaymentsApiError(featuresResult),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const features = featuresResult.data?.data ?? featuresResult.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ plans, planFeatures: features }, null, 2),
          },
        ],
      };
    }
  );
}
