/**
 * Minimal smoke test: starts the built server, lists tools over stdio, and
 * asserts the expected v2 tool surface is registered (and removed tools are gone).
 * No backend needed — tools/list doesn't hit the API.
 *
 * Usage: npm run build && node smoke.mjs
 */
import { spawn } from "node:child_process";

const EXPECTED = [
  // versioning v2
  "list_branches", "create_branch", "rename_branch", "make_branch_live",
  "get_branch_draft", "publish_draft", "list_revisions", "get_revision",
  "diff", "test_agent",
  // editing
  "update_agent", "add_agent_tool", "remove_agent_tool", "configure_call_actions",
  "create_agent", "delete_agent", "duplicate_agent",
  // playbooks
  "get_playbooks", "add_playbooks", "update_playbook", "configure_playbooks",
  // calls
  "make_call", "debug_call", "list_calls",
];

// Removed in the v2 cutover — must NOT be present.
const REMOVED = [
  "update_agent_config", "update_agent_prompt", "set_pre_call_api",
  "activate_version", "list_versions", "get_version", "get_draft",
  "list_drafts", "diff_versions", "get_draft_diff", "test_draft",
  "test_version", "rename_draft", "update_version", "compare_version_metrics",
];

const srv = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, ATOMS_API_KEY: "smoke-test" },
  stdio: ["pipe", "pipe", "inherit"],
});

const fail = (msg) => { console.error(`❌ ${msg}`); srv.kill(); process.exit(1); };
const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");

let buf = "";
srv.stdout.on("data", (d) => {
  buf += d.toString();
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== 2) continue;

    const names = new Set((msg.result?.tools ?? []).map((t) => t.name));
    const missing = EXPECTED.filter((n) => !names.has(n));
    const leaked = REMOVED.filter((n) => names.has(n));
    if (missing.length) fail(`missing expected tools: ${missing.join(", ")}`);
    if (leaked.length) fail(`removed tools still registered: ${leaked.join(", ")}`);

    // Every tool must expose a name + inputSchema.
    for (const t of msg.result?.tools ?? []) {
      if (!t.name || !t.inputSchema) fail(`tool missing name/inputSchema: ${JSON.stringify(t).slice(0, 80)}`);
    }

    console.log(`✅ ${names.size} tools registered; all ${EXPECTED.length} expected present, none of ${REMOVED.length} removed leaked.`);
    srv.kill();
    process.exit(0);
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 300);
setTimeout(() => fail("timed out waiting for tools/list"), 8000);
