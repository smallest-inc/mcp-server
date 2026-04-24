import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

export function registerCompareVersionMetrics(server: McpServer) {
  server.registerTool(
    "compare_version_metrics",
    {
      description:
        "A/B compare call performance metrics between two published versions. Shows total calls, answered calls, average duration, completion rate, total cost, and percentage deltas. Optionally filter by date range. Use this to evaluate which version performs better before deciding which to keep active.",
      inputSchema: {
        agent_id: z.string().describe("The agent ID"),
        version_a: z.string().describe("First version ID to compare"),
        version_b: z.string().describe("Second version ID to compare"),
        date_from: z
          .string()
          .optional()
          .describe("Start date for metrics (ISO 8601 format, e.g. '2025-01-01')"),
        date_to: z
          .string()
          .optional()
          .describe("End date for metrics (ISO 8601 format, e.g. '2025-01-31')"),
      },
    },
    async (params) => {
      const queryParts: string[] = [
        `versionA=${encodeURIComponent(params.version_a)}`,
        `versionB=${encodeURIComponent(params.version_b)}`,
      ];
      if (params.date_from) queryParts.push(`dateFrom=${encodeURIComponent(params.date_from)}`);
      if (params.date_to) queryParts.push(`dateTo=${encodeURIComponent(params.date_to)}`);

      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/versions/compare-metrics?${queryParts.join("&")}`
      );

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
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
