import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaymentsApiError, paymentsApi } from "../payments-api.js";

export function registerGetFeatures(server: McpServer) {
  server.registerTool(
    "get_features",
    {
      description:
        "Get the effective features for your organization — the actual feature access, limits, and credit rates after applying your plan and any custom overrides. Shows what your org can use and at what cost per unit.",
      inputSchema: {
        include_catalog: z
          .boolean()
          .optional()
          .describe("Also return the full feature catalog (all available features across all plans)"),
      },
    },
    async (params) => {
      const effectiveResult = await paymentsApi("GET", "/features/effective");

      if (!effectiveResult.ok) {
        return { content: [{ type: "text" as const, text: formatPaymentsApiError(effectiveResult) }] };
      }

      const effective = effectiveResult.data?.data ?? effectiveResult.data;

      if (!params.include_catalog) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(effective, null, 2),
            },
          ],
        };
      }

      const catalogResult = await paymentsApi("GET", "/features");

      if (!catalogResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  effectiveFeatures: effective,
                  catalogError: formatPaymentsApiError(catalogResult),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const catalog = catalogResult.data?.data ?? catalogResult.data;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { effectiveFeatures: effective, featureCatalog: catalog },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
