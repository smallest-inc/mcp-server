import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { atomsApi, formatApiError } from "../api.js";

/** Webhook event types the backend fires, keyed by the value it expects.
 *  - pre-conversation:    fired when a call starts
 *  - post-conversation:   fired when a call ends
 *  - analytics-completed: fired after post-call analytics are computed */
const WEBHOOK_EVENT_TYPES = ["pre-conversation", "post-conversation", "analytics-completed"] as const;

const eventTypeSchema = z
  .enum(WEBHOOK_EVENT_TYPES)
  .describe(
    "Which event to deliver: 'pre-conversation' (call start), 'post-conversation' (call end), or 'analytics-completed' (post-call analytics ready)."
  );

const webhookIdSchema = z.string().regex(/^[a-f\d]{24}$/, "Invalid webhook id (expected a 24-char hex ObjectId)");

// Only summarise the fields callers care about; the raw doc also carries encryption metadata.
function summariseWebhook(w: any) {
  if (!w || typeof w !== "object") return w;
  return {
    _id: w._id,
    url: w.url,
    description: w.description,
    status: w.status,
    subscriptions: (w.subscriptions ?? []).map((s: any) => ({
      _id: s._id,
      eventType: s.eventType,
      agent: s.agentId ? { _id: s.agentId._id, name: s.agentId.name } : null,
    })),
    headers: w.headers,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function registerCreateWebhook(server: McpServer) {
  server.registerTool(
    "create_webhook",
    {
      description:
        "Create a webhook endpoint and attach it to agents for specific events. This is how you subscribe an agent to call-start ('pre-conversation'), call-end ('post-conversation'), and post-call-analytics ('analytics-completed') deliveries. " +
        "Each entry in `events` attaches one event type on one agent to this endpoint — repeat the same agent_id with different event types to subscribe it to multiple events. " +
        "Subscriptions are set only at creation time; use update_webhook only to change the URL, description, or headers (not the agent/event attachments).",
      inputSchema: {
        endpoint: z.string().url().describe("The HTTPS URL that will receive webhook deliveries."),
        description: z.string().min(1).describe("A human-readable label for this webhook."),
        events: z
          .array(
            z.object({
              agent_id: z.string().describe("The agent to attach this event to."),
              event_type: eventTypeSchema,
            })
          )
          .min(1)
          .describe("Agent + event-type pairs to subscribe to this endpoint."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Custom headers sent with every delivery (e.g. gateway API keys), as key/value pairs. Max 10; reserved headers like content-type are rejected."
          ),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {
        endpoint: params.endpoint,
        description: params.description,
        events: params.events.map((e) => ({ agentId: e.agent_id, eventType: e.event_type })),
      };
      if (params.headers !== undefined) body.headers = params.headers;

      const result = await atomsApi("POST", "/webhook", body);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const webhookId = result.data?.data ?? result.data;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Webhook created and attached to ${params.events.length} agent-event subscription${params.events.length === 1 ? "" : "s"}.`,
                webhookId,
                events: params.events,
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

export function registerGetWebhooks(server: McpServer) {
  server.registerTool(
    "get_webhooks",
    {
      description:
        "List the organization's webhooks, or fetch a single one by ID. Each webhook includes its subscriptions — the agents and event types (pre-conversation, post-conversation, analytics-completed) it's attached to.",
      inputSchema: {
        webhook_id: webhookIdSchema.optional().describe("Fetch just this webhook. Omit to list all webhooks."),
      },
    },
    async (params) => {
      const path = params.webhook_id
        ? `/webhook?webhookId=${encodeURIComponent(params.webhook_id)}`
        : "/webhook";

      const result = await atomsApi("GET", path);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      const summary = Array.isArray(data) ? data.map(summariseWebhook) : summariseWebhook(data);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              Array.isArray(summary) ? { count: summary.length, webhooks: summary } : summary,
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

export function registerUpdateWebhook(server: McpServer) {
  server.registerTool(
    "update_webhook",
    {
      description:
        "Update a webhook's endpoint URL, description, or custom headers. Provide at least one field. " +
        "This does NOT change which agents/events are attached — subscriptions are fixed at creation. To change attachments, delete the webhook and create a new one.",
      inputSchema: {
        webhook_id: webhookIdSchema.describe("The webhook to update."),
        endpoint: z.string().url().optional().describe("New delivery URL."),
        description: z.string().min(1).optional().describe("New description."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Replace all custom headers. Pass an empty object ({}) to remove all custom headers."),
      },
    },
    async (params) => {
      const body: Record<string, unknown> = {};
      if (params.endpoint !== undefined) body.endpoint = params.endpoint;
      if (params.description !== undefined) body.description = params.description;
      if (params.headers !== undefined) body.headers = params.headers;

      if (Object.keys(body).length === 0) {
        return {
          content: [
            { type: "text" as const, text: "Provide at least one of: endpoint, description, headers." },
          ],
        };
      }

      const result = await atomsApi("PATCH", `/webhook/${encodeURIComponent(params.webhook_id)}`, body);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: "Webhook updated.", webhookId: params.webhook_id }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerDeleteWebhook(server: McpServer) {
  server.registerTool(
    "delete_webhook",
    {
      description:
        "Delete a webhook and all of its agent/event subscriptions. This detaches it from every agent it was attached to.",
      inputSchema: {
        webhook_id: webhookIdSchema.describe("The webhook to delete."),
      },
    },
    async (params) => {
      const result = await atomsApi("DELETE", `/webhook/${encodeURIComponent(params.webhook_id)}`);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Webhook ${params.webhook_id} deleted successfully.`,
          },
        ],
      };
    }
  );
}

export function registerGetWebhookEvents(server: McpServer) {
  server.registerTool(
    "get_webhook_events",
    {
      description:
        "List recent delivery events (attempts, payloads, and outcomes) for a webhook. Use this to verify that call-start/call-end/analytics events are firing and reaching your endpoint.",
      inputSchema: {
        webhook_id: webhookIdSchema.describe("The webhook whose delivery events to fetch."),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/webhook/events?webhookId=${encodeURIComponent(params.webhook_id)}`
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
