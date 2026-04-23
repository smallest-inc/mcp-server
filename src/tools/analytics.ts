import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  analyticsFilterSchema,
  dateScopedSchema,
  callAnalyticsEndpoint,
  callDateScopedEndpoint,
} from "./analytics-helpers.js";

// ─── Date-Range Analytics ────────────────────────────────────────────────────

export function registerGetDashboard(server: McpServer) {
  server.registerTool(
    "get_dashboard",
    {
      description:
        "Get the full analytics dashboard in a single call — includes summary KPIs, call volume timeseries, call outcomes, pickup rates by number, hourly performance, and duration stats.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("dashboard", params)
  );
}

export function registerGetCallVolume(server: McpServer) {
  server.registerTool(
    "get_call_volume",
    {
      description:
        "Get call volume over time as a daily timeseries. Shows how many calls were made each day in the date range.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("call-volume-timeseries", params)
  );
}

export function registerGetCallOutcomes(server: McpServer) {
  server.registerTool(
    "get_call_outcomes",
    {
      description:
        "Get call outcome distribution over time — daily breakdown of completed, failed, and no-answer calls, plus totals.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("call-outcomes-timeseries", params)
  );
}

export function registerGetAgentPerformance(server: McpServer) {
  server.registerTool(
    "get_agent_performance",
    {
      description:
        "Compare agent performance — shows each agent's total calls, average duration, completion rate, and cost. Use to find top and bottom performers.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("agent-performance", params)
  );
}

export function registerGetHourlyPerformance(server: McpServer) {
  server.registerTool(
    "get_hourly_performance",
    {
      description:
        "Get performance metrics by hour of day (0-23). Shows call count, average duration, and cost per hour. Useful for identifying peak hours.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("hourly-performance", params)
  );
}

export function registerGetPickupRates(server: McpServer) {
  server.registerTool(
    "get_pickup_rates",
    {
      description:
        "Get pickup rate by phone number — shows total calls, answered calls, and pickup rate for each outbound number. Useful for optimizing caller IDs.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("pickup-rate-by-number", params)
  );
}

export function registerGetPhoneNumberTrends(server: McpServer) {
  server.registerTool(
    "get_phone_number_trends",
    {
      description:
        "Get per-phone-number daily trends — calls, pickup rate, and average duration per day for each number.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("phone-number-trends", params)
  );
}

export function registerGetWeeklyTrends(server: McpServer) {
  server.registerTool(
    "get_weekly_trends",
    {
      description:
        "Get weekly aggregated metrics — calls, average duration, and cost per week. Good for spotting week-over-week trends.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("weekly-trends", params)
  );
}

export function registerGetDurationStats(server: McpServer) {
  server.registerTool(
    "get_duration_stats",
    {
      description:
        "Get call duration statistics — average, median, min, max, and p95 duration. Shows how long calls typically last.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("duration-stats", params)
  );
}

export function registerGetAttemptCohorts(server: McpServer) {
  server.registerTool(
    "get_attempt_cohorts",
    {
      description:
        "Get attempt cohort analysis — shows volume and success rate by attempt number (1st attempt, 2nd attempt, etc.). Useful for optimizing retry strategies.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("attempt-cohort", params)
  );
}

export function registerGetCallCountsByDay(server: McpServer) {
  server.registerTool(
    "get_call_counts_by_day",
    {
      description:
        "Get call count per day as a simple histogram. Shows { day, count } pairs.",
      inputSchema: analyticsFilterSchema,
    },
    (params) => callAnalyticsEndpoint("call-counts-by-day", params)
  );
}

export function registerGetCreditUsage(server: McpServer) {
  server.registerTool(
    "get_credit_usage",
    {
      description:
        "Get daily credit/cost usage over time — shows credits consumed each day and total for the period. Useful for billing and budget tracking.",
      inputSchema: {
        start_date: analyticsFilterSchema.start_date,
        end_date: analyticsFilterSchema.end_date,
      },
    },
    (params) => callAnalyticsEndpoint("usage/timeseries", params)
  );
}

// ─── Date-Scoped Analytics (single day) ──────────────────────────────────────

export function registerGetConcurrency(server: McpServer) {
  server.registerTool(
    "get_concurrency",
    {
      description:
        "Get concurrent call counts for a specific date — minute-by-minute concurrency data plus per-agent max concurrency. Shows how many calls were running simultaneously.",
      inputSchema: dateScopedSchema,
    },
    (params) => callDateScopedEndpoint("concurrency", params)
  );
}

export function registerGetCallStartDistribution(server: McpServer) {
  server.registerTool(
    "get_call_start_distribution",
    {
      description:
        "Get call start distribution by hour for a specific date — shows how many calls started in each hour (0-23). Useful for scheduling and capacity planning.",
      inputSchema: dateScopedSchema,
    },
    (params) => callDateScopedEndpoint("call-start-distribution", params)
  );
}

export function registerGetDailySummary(server: McpServer) {
  server.registerTool(
    "get_daily_summary",
    {
      description:
        "Get summary statistics for a specific date — total calls, completed, failed, no-answer, in-progress, in-queue, average duration, and total cost.",
      inputSchema: dateScopedSchema,
    },
    (params) => callDateScopedEndpoint("daily-call-summary", params)
  );
}

// ─── Register all analytics tools ────────────────────────────────────────────

export function registerAnalyticsTools(server: McpServer) {
  registerGetDashboard(server);
  registerGetCallVolume(server);
  registerGetCallOutcomes(server);
  registerGetAgentPerformance(server);
  registerGetHourlyPerformance(server);
  registerGetPickupRates(server);
  registerGetPhoneNumberTrends(server);
  registerGetWeeklyTrends(server);
  registerGetDurationStats(server);
  registerGetAttemptCohorts(server);
  registerGetCallCountsByDay(server);
  registerGetCreditUsage(server);
  registerGetConcurrency(server);
  registerGetCallStartDistribution(server);
  registerGetDailySummary(server);
}
