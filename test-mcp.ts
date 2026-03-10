/**
 * Integration test for the Atoms MCP server.
 *
 * Spawns the server as a child process, connects via MCP Client over stdio,
 * and exercises every tool:
 *   1. Lists all tools and validates expected tools + schemas exist
 *   2. Calls each tool and validates behavior (using a mock API via env override)
 *
 * Usage: ATOMS_API_KEY=test npx tsx test-mcp.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertIncludes(text: string, substring: string, msg: string) {
  assert(text.includes(substring), msg);
}

// ── Mock API Server ──────────────────────────────────────────────────────────

import http from "node:http";

/** Tiny HTTP server that simulates the Atoms API for testing. */
function createMockApi(): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const path = url.pathname;
      let body = "";

      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");

        // Auth endpoint — must match auth.ts expected shape: { organizations: [{ orgId }], userId }
        if (path === "/api/v1/account/get-account-details") {
          return res.end(JSON.stringify({ organizations: [{ orgId: "org1" }], userId: "u1" }));
        }

        // GET /agent?... (list agents) — only exact /agent path with no sub-path
        if (path === "/api/v1/agent" && req.method === "GET") {
          return res.end(
            JSON.stringify({
              data: {
                agents: [
                  {
                    _id: "agent-sp-1",
                    name: "Test SP Agent",
                    description: "single prompt",
                    slmModel: "gpt-4.1",
                    workflowType: "single_prompt",
                    workflowId: "wf-1",
                    synthesizer: { voiceConfig: { model: "waves_lightning_large", voiceId: "rachel" }, speed: 1.2 },
                    language: { default: "en", supported: ["en"], switching: { isEnabled: false } },
                    defaultVariables: { prospect_name: "Default" },
                    redactionConfig: { isEnabled: false },
                    createdAt: "2025-01-01",
                    updatedAt: "2025-01-01",
                    totalCalls: 5,
                    backgroundSound: "",
                  },
                  {
                    _id: "agent-wg-1",
                    name: "Test WG Agent",
                    description: "workflow graph",
                    slmModel: "gpt-4o",
                    workflowType: "workflow_graph",
                    workflowId: "wf-2",
                    synthesizer: { voiceConfig: { model: "waves", voiceId: "sophia" }, speed: 1 },
                    language: { default: "en", supported: ["en"], switching: { isEnabled: false } },
                    redactionConfig: { isEnabled: true },
                    globalPrompt: "You are a global prompt.",
                    createdAt: "2025-01-01",
                    updatedAt: "2025-01-01",
                    totalCalls: 10,
                    backgroundSound: "office",
                  },
                ],
              },
            })
          );
        }

        // GET /agent/:id (single agent)
        const agentMatch = path.match(/^\/api\/v1\/agent\/([^/]+)$/);
        if (agentMatch && req.method === "GET" && !path.includes("?")) {
          const id = agentMatch[1];
          if (id === "agent-sp-1") {
            return res.end(
              JSON.stringify({
                data: {
                  _id: "agent-sp-1",
                  name: "Test SP Agent",
                  description: "single prompt agent",
                  slmModel: "gpt-4.1",
                  workflowType: "single_prompt",
                  workflowId: "wf-1",
                  synthesizer: { voiceConfig: { model: "waves_lightning_large", voiceId: "rachel" }, speed: 1.2 },
                  language: { default: "en", supported: ["en"], switching: { isEnabled: false } },
                  defaultVariables: { prospect_name: "Default" },
                  redactionConfig: { isEnabled: false },
                  createdAt: "2025-01-01",
                  updatedAt: "2025-01-01",
                  totalCalls: 5,
                  backgroundSound: "",
                },
              })
            );
          }
          if (id === "agent-wg-1") {
            return res.end(
              JSON.stringify({
                data: {
                  _id: "agent-wg-1",
                  name: "Test WG Agent",
                  description: "workflow graph agent",
                  slmModel: "gpt-4o",
                  workflowType: "workflow_graph",
                  workflowId: "wf-2",
                  synthesizer: { voiceConfig: { model: "waves", voiceId: "sophia" }, speed: 1 },
                  language: { default: "en", supported: ["en"], switching: { isEnabled: false } },
                  redactionConfig: { isEnabled: true },
                  globalPrompt: "You are a global prompt.",
                  createdAt: "2025-01-01",
                  updatedAt: "2025-01-01",
                  totalCalls: 10,
                  backgroundSound: "office",
                },
              })
            );
          }
          res.statusCode = 404;
          return res.end(JSON.stringify({ message: "Agent not found" }));
        }

        // GET /agent/:id/workflow
        const workflowMatch = path.match(/^\/api\/v1\/agent\/([^/]+)\/workflow$/);
        if (workflowMatch && req.method === "GET") {
          const id = workflowMatch[1];
          if (id === "agent-sp-1") {
            // Match real API shape: { status: true, data: { prompt, tools } }
            return res.end(
              JSON.stringify({
                status: true,
                data: {
                  prompt: "You are a helpful sales agent. Use {{prospect_name}} when greeting.",
                  tools: [{ type: "end_call", name: "hangup" }],
                },
              })
            );
          }
          if (id === "agent-wg-1") {
            return res.end(
              JSON.stringify({
                data: {
                  type: "workflow_graph",
                  data: { nodes: [], edges: [] },
                },
              })
            );
          }
          res.statusCode = 404;
          return res.end(JSON.stringify({ message: "Not found" }));
        }

        // POST /agent (create)
        if (path === "/api/v1/agent" && req.method === "POST") {
          return res.end(JSON.stringify({ data: "agent-new-1" }));
        }

        // PATCH /agent/:id (update config)
        const patchAgentMatch = path.match(/^\/api\/v1\/agent\/([^/]+)$/);
        if (patchAgentMatch && req.method === "PATCH") {
          return res.end(JSON.stringify({ status: true }));
        }

        // PATCH /workflow/:id
        const patchWorkflowMatch = path.match(/^\/api\/v1\/workflow\//);
        if (patchWorkflowMatch && req.method === "PATCH") {
          return res.end(JSON.stringify({ status: true }));
        }

        // POST /conversation/outbound
        if (path === "/api/v1/conversation/outbound" && req.method === "POST") {
          return res.end(JSON.stringify({ data: { conversationId: "CALL-TEST-123" } }));
        }

        // GET /analytics/conversation-details/:id
        const debugMatch = path.match(/^\/api\/v1\/analytics\/conversation-details\//);
        if (debugMatch && req.method === "GET") {
          return res.end(
            JSON.stringify({
              data: {
                callId: "CALL-TEST-123",
                transcript: [
                  { role: "agent", text: "Hello!" },
                  { role: "user", text: "Hi there" },
                ],
                events: [
                  { type: "turn_latency_analysis", latencyMs: 120 },
                  { type: "turn_latency_analysis", latencyMs: 200 },
                  { type: "turn_latency_analysis", latencyMs: 150 },
                  { type: "turn_latency_analysis", latencyMs: 180 },
                  { type: "turn_latency_analysis", latencyMs: 350 },
                ],
                cost: { total: 0.05 },
              },
            })
          );
        }

        // GET /analytics/call-counts-log
        if (path.startsWith("/api/v1/analytics/call-counts-log")) {
          return res.end(
            JSON.stringify({ data: { callLogs: [{ callId: "CALL-1", callStatus: "completed" }] } })
          );
        }

        // GET /analytics/summary
        if (path.startsWith("/api/v1/analytics/summary")) {
          return res.end(JSON.stringify({ data: { totalCalls: 100, totalDurationMs: 500000 } }));
        }

        // GET /campaign
        if (path.startsWith("/api/v1/campaign")) {
          return res.end(JSON.stringify({ data: { campaigns: [] } }));
        }

        // GET /product/phone-numbers
        if (path.startsWith("/api/v1/product/phone-numbers")) {
          return res.end(
            JSON.stringify({
              data: [
                {
                  _id: "pn-1",
                  attributes: { phoneNumber: "+14155551234", countryCode: "US", provider: "twilio" },
                  isActive: true,
                },
              ],
            })
          );
        }

        // DELETE /agent/:id/archive
        if (path.match(/\/agent\/.*\/archive/) && req.method === "DELETE") {
          return res.end(JSON.stringify({ status: true }));
        }

        // Fallback
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `Mock: unhandled ${req.method} ${path}` }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/api/v1`, server });
    });
  });
}

// ── Main Test ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔧 Starting mock Atoms API...");
  const mock = await createMockApi();
  console.log(`   Mock API running at ${mock.url}\n`);

  console.log("🔌 Connecting to MCP server...");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    cwd: "/tmp/mcp-server",
    env: {
      ...process.env,
      ATOMS_API_KEY: "test-key-123",
      ATOMS_API_URL: mock.url,
    },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  console.log("   Connected!\n");

  // ─── Test 1: List tools ────────────────────────────────────────────────────
  console.log("═══ TEST 1: Tool Registration ═══");
  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name).sort();
  console.log(`   Found ${tools.length} tools: ${toolNames.join(", ")}\n`);

  const expectedTools = [
    "create_agent",
    "debug_call",
    "delete_agent",
    "get_agent",
    "get_agent_prompt",
    "get_agents",
    "get_call_logs",
    "get_campaigns",
    "get_phone_numbers",
    "get_usage_stats",
    "make_call",
    "update_agent_config",
    "update_agent_prompt",
  ];
  for (const name of expectedTools) {
    assert(toolNames.includes(name), `Tool '${name}' is registered`);
  }

  // ─── Test 2: Validate schemas for new/changed tools ────────────────────────
  console.log("\n═══ TEST 2: Schema Validation ═══");
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

  // make_call should have 'variables'
  const makeCallProps = (toolMap["make_call"].inputSchema as any).properties;
  assert("variables" in makeCallProps, "make_call has 'variables' parameter");
  assert("phone_number" in makeCallProps, "make_call has 'phone_number' parameter");

  // update_agent_config should have 'default_variables' and 'slm_model'
  const updateConfigProps = (toolMap["update_agent_config"].inputSchema as any).properties;
  assert("default_variables" in updateConfigProps, "update_agent_config has 'default_variables' parameter");
  assert("slm_model" in updateConfigProps, "update_agent_config has 'slm_model' parameter");
  assert("synthesizer" in updateConfigProps, "update_agent_config has 'synthesizer' parameter");

  // get_agent should have 'agent_id'
  const getAgentProps = (toolMap["get_agent"].inputSchema as any).properties;
  assert("agent_id" in getAgentProps, "get_agent has 'agent_id' parameter");

  // get_agent_prompt should have 'agent_id'
  const getPromptProps = (toolMap["get_agent_prompt"].inputSchema as any).properties;
  assert("agent_id" in getPromptProps, "get_agent_prompt has 'agent_id' parameter");

  // ─── Test 3: get_agent — single_prompt agent ──────────────────────────────
  console.log("\n═══ TEST 3: get_agent (single_prompt) ═══");
  const getAgentResult = await client.callTool({ name: "get_agent", arguments: { agent_id: "agent-sp-1" } });
  const agentData = JSON.parse((getAgentResult.content as any)[0].text);
  assert(agentData._id === "agent-sp-1", "get_agent returns correct agent ID");
  assert(agentData.slmModel === "gpt-4.1", "get_agent returns slmModel");
  assert(agentData.defaultVariables?.prospect_name === "Default", "get_agent returns defaultVariables");
  assert(agentData.workflowType === "single_prompt", "get_agent returns workflowType");
  assert(agentData.synthesizer?.voiceConfig?.voiceId === "rachel", "get_agent returns voice config");

  // ─── Test 4: get_agent_prompt — single_prompt agent ───────────────────────
  console.log("\n═══ TEST 4: get_agent_prompt (single_prompt) ═══");
  const getPromptResult = await client.callTool({ name: "get_agent_prompt", arguments: { agent_id: "agent-sp-1" } });
  const promptData = JSON.parse((getPromptResult.content as any)[0].text);
  assert(promptData.workflow_type === "single_prompt", "get_agent_prompt returns workflow_type");
  assert(typeof promptData.prompt === "string" && promptData.prompt.length > 0, "get_agent_prompt returns prompt text");
  assert(Array.isArray(promptData.tools) && promptData.tools.length > 0, "get_agent_prompt returns tools array");

  // ─── Test 5: get_agent_prompt — workflow_graph agent ──────────────────────
  console.log("\n═══ TEST 5: get_agent_prompt (workflow_graph) ═══");
  const getPromptWgResult = await client.callTool({ name: "get_agent_prompt", arguments: { agent_id: "agent-wg-1" } });
  const promptWgData = JSON.parse((getPromptWgResult.content as any)[0].text);
  assert(promptWgData.workflow_type === "workflow_graph", "get_agent_prompt returns workflow_graph type");
  assert(promptWgData.global_prompt === "You are a global prompt.", "get_agent_prompt returns globalPrompt for wg");
  assertIncludes(promptWgData.note, "does not support", "get_agent_prompt includes MCP limitation note for wg");

  // ─── Test 6: Conversation flow blocking on mutation tools ─────────────────
  console.log("\n═══ TEST 6: Conversation Flow Blocking ═══");

  // update_agent_prompt on workflow_graph agent
  const updatePromptWg = await client.callTool({
    name: "update_agent_prompt",
    arguments: { agent_id: "agent-wg-1", prompt: "New prompt" },
  });
  const updatePromptWgText = (updatePromptWg.content as any)[0].text;
  assertIncludes(updatePromptWgText, "does not support conversation flow", "update_agent_prompt blocks workflow_graph");

  // update_agent_config on workflow_graph agent
  const updateConfigWg = await client.callTool({
    name: "update_agent_config",
    arguments: { agent_id: "agent-wg-1", name: "New Name" },
  });
  const updateConfigWgText = (updateConfigWg.content as any)[0].text;
  assertIncludes(updateConfigWgText, "does not support conversation flow", "update_agent_config blocks workflow_graph");

  // make_call on workflow_graph agent
  const makeCallWg = await client.callTool({
    name: "make_call",
    arguments: { agent_id: "agent-wg-1", phone_number: "+14155551234" },
  });
  const makeCallWgText = (makeCallWg.content as any)[0].text;
  assertIncludes(makeCallWgText, "does not support conversation flow", "make_call blocks workflow_graph");

  // ─── Test 7: Mutation tools work on single_prompt agents ──────────────────
  console.log("\n═══ TEST 7: Mutation Tools on single_prompt ═══");

  // update_agent_prompt on single_prompt agent
  const updatePromptSp = await client.callTool({
    name: "update_agent_prompt",
    arguments: { agent_id: "agent-sp-1", prompt: "You are a new prompt" },
  });
  const updatePromptSpText = (updatePromptSp.content as any)[0].text;
  assertIncludes(updatePromptSpText, "updated successfully", "update_agent_prompt works on single_prompt");

  // update_agent_config with new fields
  const updateConfigSp = await client.callTool({
    name: "update_agent_config",
    arguments: {
      agent_id: "agent-sp-1",
      slm_model: "gpt-4.1",
      default_variables: { prospect_name: "John", company: "Acme" },
      synthesizer: { voiceConfig: { model: "waves_lightning_large", voiceId: "rachel" } },
    },
  });
  const updateConfigSpText = (updateConfigSp.content as any)[0].text;
  assertIncludes(updateConfigSpText, "updated successfully", "update_agent_config works on single_prompt");
  assertIncludes(updateConfigSpText, "slmModel", "update_agent_config reports slmModel updated");
  assertIncludes(updateConfigSpText, "defaultVariables", "update_agent_config reports defaultVariables updated");
  assertIncludes(updateConfigSpText, "synthesizer", "update_agent_config reports synthesizer updated");

  // ─── Test 8: make_call with variables ─────────────────────────────────────
  console.log("\n═══ TEST 8: make_call with variables ═══");
  const makeCallResult = await client.callTool({
    name: "make_call",
    arguments: {
      agent_id: "agent-sp-1",
      phone_number: "+14155559999",
      variables: { prospect_name: "Jane", prospect_company: "Widgets Inc" },
    },
  });
  const makeCallData = JSON.parse((makeCallResult.content as any)[0].text);
  assert(makeCallData.callId === "CALL-TEST-123", "make_call returns call ID");
  assertIncludes(makeCallData.message, "initiated", "make_call returns initiated message");

  // ─── Test 9: create_agent defaults ────────────────────────────────────────
  console.log("\n═══ TEST 9: create_agent defaults ═══");
  const createResult = await client.callTool({
    name: "create_agent",
    arguments: { name: "My New Agent", description: "A test agent" },
  });
  const createData = JSON.parse((createResult.content as any)[0].text);
  assert(createData.agentId === "agent-new-1", "create_agent returns agent ID");
  assert(createData.defaults_applied.workflowType === "single_prompt", "create_agent defaults to single_prompt");
  assert(createData.defaults_applied.slmModel === "gpt-4.1", "create_agent defaults to gpt-4.1");
  assertIncludes(createData.defaults_applied.voice, "rachel", "create_agent defaults to rachel voice");

  // ─── Test 10: debug_call latency summary ──────────────────────────────────
  console.log("\n═══ TEST 10: debug_call latency summary ═══");
  const debugResult = await client.callTool({
    name: "debug_call",
    arguments: { call_id: "CALL-TEST-123" },
  });
  const debugData = JSON.parse((debugResult.content as any)[0].text);
  assert(debugData.latency_summary !== null && debugData.latency_summary !== undefined, "debug_call includes latency_summary");
  assert(debugData.latency_summary.turn_count === 5, "latency_summary has correct turn_count");
  assert(typeof debugData.latency_summary.avg_ms === "number", "latency_summary has avg_ms");
  assert(typeof debugData.latency_summary.median_ms === "number", "latency_summary has median_ms");
  assert(typeof debugData.latency_summary.p95_ms === "number", "latency_summary has p95_ms");
  // Verify the math: latencies are [120, 150, 180, 200, 350]
  assert(debugData.latency_summary.avg_ms === 200, "latency avg_ms = 200");
  assert(debugData.latency_summary.median_ms === 180, "latency median_ms = 180");
  assert(debugData.latency_summary.p95_ms === 350, "latency p95_ms = 350");
  assert(debugData.latency_summary.min_ms === 120, "latency min_ms = 120");
  assert(debugData.latency_summary.max_ms === 350, "latency max_ms = 350");

  // ─── Test 11: Other existing tools still work ─────────────────────────────
  console.log("\n═══ TEST 11: Existing tools ═══");

  const agentsResult = await client.callTool({ name: "get_agents", arguments: {} });
  const agentsText = (agentsResult.content as any)[0].text;
  assertIncludes(agentsText, "Test SP Agent", "get_agents returns agents");

  const phoneResult = await client.callTool({ name: "get_phone_numbers", arguments: {} });
  const phoneText = (phoneResult.content as any)[0].text;
  assertIncludes(phoneText, "+14155551234", "get_phone_numbers returns numbers");

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════\n");

  await client.close();
  mock.server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
