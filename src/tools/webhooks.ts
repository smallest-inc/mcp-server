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

// Event types are never safe to guess — the caller must confirm which the user wants.
const NEVER_ASSUME_EVENTS =
  "Never guess or default the event types. If the user hasn't said which of call-start (pre-conversation), " +
  "call-end (post-conversation), or analytics (analytics-completed) they want, ask them before calling.";

const webhookIdSchema = z.string().regex(/^[a-f\d]{24}$/, "Invalid webhook id (expected a 24-char hex ObjectId)");

const agentIdSchema = z.string().regex(/^[a-f\d]{24}$/, "Invalid agent id (expected a 24-char hex ObjectId)");

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
        "Register a NEW webhook endpoint (delivery URL). Use this only when the target URL does not already exist as a webhook. " +
        "To point an agent at an ALREADY-REGISTERED webhook, do NOT create a new one — call get_webhooks to find it, then attach_agent_webhook. " +
        "`events` is optional: omit it to register the endpoint only, or pass agent+event pairs to attach in the same call. " +
        NEVER_ASSUME_EVENTS,
      inputSchema: {
        endpoint: z.string().url().describe("The HTTPS URL that will receive webhook deliveries."),
        description: z.string().min(1).describe("A human-readable label for this webhook."),
        events: z
          .array(
            z.object({
              agent_id: agentIdSchema.describe("The agent to attach this event to."),
              event_type: eventTypeSchema,
            })
          )
          .optional()
          .describe(
            "Optional agent + event-type pairs to subscribe at creation. Repeat an agent_id with different event types for multiple events. " +
              NEVER_ASSUME_EVENTS
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Custom headers sent with every delivery (e.g. gateway API keys), as key/value pairs. Max 10; reserved headers like content-type are rejected."
          ),
      },
    },
    async (params) => {
      const events = params.events ?? [];
      const body: Record<string, unknown> = {
        endpoint: params.endpoint,
        description: params.description,
        events: events.map((e) => ({ agentId: e.agent_id, eventType: e.event_type })),
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
                message:
                  events.length > 0
                    ? `Webhook created and attached to ${events.length} agent-event subscription${events.length === 1 ? "" : "s"}.`
                    : "Webhook endpoint created (no agent attached yet). Use attach_agent_webhook to subscribe an agent.",
                webhookId,
                events,
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

export function registerAttachAgentWebhook(server: McpServer) {
  server.registerTool(
    "attach_agent_webhook",
    {
      description:
        "Attach an EXISTING webhook to an agent for the given events. This is the right tool for 'send this agent's call-start/call-end/analytics to an already-created webhook' — find the webhook with get_webhooks first, then pass its id here. " +
        "WARNING: this REPLACES the agent's current subscriptions — the backend deletes all of the agent's existing webhook subscriptions and recreates them for this webhook only, so an agent points at one webhook at a time. To only remove subscriptions, use detach_agent_webhooks. " +
        NEVER_ASSUME_EVENTS,
      inputSchema: {
        agent_id: agentIdSchema.describe("The agent to attach the webhook to."),
        webhook_id: webhookIdSchema.describe("An existing webhook's id (from get_webhooks)."),
        event_types: z
          .array(eventTypeSchema)
          .min(1)
          .describe("The events to deliver to this webhook for this agent. " + NEVER_ASSUME_EVENTS),
      },
    },
    async (params) => {
      // De-dupe event types; the backend creates one subscription per entry.
      const eventTypes = [...new Set(params.event_types)];
      const result = await atomsApi(
        "POST",
        `/agent/${encodeURIComponent(params.agent_id)}/webhook-subscriptions`,
        { webhookId: params.webhook_id, eventTypes }
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Agent ${params.agent_id} now subscribed to webhook ${params.webhook_id} for: ${eventTypes.join(", ")}. Any previous subscriptions for this agent were replaced.`,
                agentId: params.agent_id,
                webhookId: params.webhook_id,
                eventTypes,
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

export function registerGetAgentWebhooks(server: McpServer) {
  server.registerTool(
    "get_agent_webhooks",
    {
      description:
        "List an agent's current webhook subscriptions — which webhook it's attached to and for which events (pre-conversation, post-conversation, analytics-completed).",
      inputSchema: {
        agent_id: agentIdSchema.describe("The agent whose subscriptions to fetch."),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "GET",
        `/agent/${encodeURIComponent(params.agent_id)}/webhook-subscriptions`
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      const data = result.data?.data ?? result.data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}

export function registerDetachAgentWebhooks(server: McpServer) {
  server.registerTool(
    "detach_agent_webhooks",
    {
      description:
        "Remove ALL of an agent's webhook subscriptions. The agent will stop receiving call-start/call-end/analytics deliveries until re-attached with attach_agent_webhook. This does not delete the webhook endpoint itself.",
      inputSchema: {
        agent_id: agentIdSchema.describe("The agent whose subscriptions to remove."),
      },
    },
    async (params) => {
      const result = await atomsApi(
        "DELETE",
        `/agent/${encodeURIComponent(params.agent_id)}/webhook-subscriptions`
      );
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: formatApiError(result) }] };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `All webhook subscriptions removed for agent ${params.agent_id}.`,
          },
        ],
      };
    }
  );
}
