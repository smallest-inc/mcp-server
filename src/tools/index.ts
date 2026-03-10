import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCreateAgent } from "./create-agent.js";
import { registerDebugCall } from "./debug-call.js";
import { registerDeleteAgent } from "./delete-agent.js";
import { registerGetAgent } from "./get-agent.js";
import { registerGetAgentPrompt } from "./get-agent-prompt.js";
import { registerGetAgents } from "./get-agents.js";
import { registerGetCallLogs } from "./get-call-logs.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetPhoneNumbers } from "./get-phone-numbers.js";
import { registerGetUsageStats } from "./get-usage-stats.js";
import { registerMakeCall } from "./make-call.js";
import { registerUpdateAgentConfig } from "./update-agent-config.js";
import { registerUpdateAgentPrompt } from "./update-agent-prompt.js";

export function registerTools(server: McpServer) {
  registerGetCallLogs(server);
  registerGetAgents(server);
  registerGetAgent(server);
  registerGetAgentPrompt(server);
  registerGetUsageStats(server);
  registerDebugCall(server);
  registerGetCampaigns(server);
  registerCreateAgent(server);
  registerUpdateAgentPrompt(server);
  registerUpdateAgentConfig(server);
  registerDeleteAgent(server);
  registerMakeCall(server);
  registerGetPhoneNumbers(server);
}
