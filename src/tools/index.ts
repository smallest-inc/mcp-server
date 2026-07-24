import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAddAgentTool } from "./add-agent-tool.js";
import { registerAddAudienceMembers } from "./add-audience-members.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerChatWithAgent } from "./chat.js";
import { registerConfigureCallActions } from "./configure-call-actions.js";
import { registerCreateAgent } from "./create-agent.js";
import { registerCreateBranch } from "./create-branch.js";
import { registerCreateCampaign } from "./create-campaign.js";
import { registerDebugCall } from "./debug-call.js";
import { registerDeleteAgent } from "./delete-agent.js";
import { registerDeleteAudienceMembers } from "./delete-audience-members.js";
import { registerDeleteAudience } from "./delete-audience.js";
import { registerDeleteBranch } from "./delete-branch.js";
import { registerDeleteCampaign } from "./delete-campaign.js";
import { registerDiff } from "./diff.js";
import { registerDuplicateAgent } from "./duplicate-agent.js";
import { registerExportCampaignLogs } from "./export-campaign-logs.js";
import { registerGetAgent } from "./get-agent.js";
import { registerGetAgentPrompt } from "./get-agent-prompt.js";
import { registerGetAgents } from "./get-agents.js";
import { registerGetAudienceMembers } from "./get-audience-members.js";
import { registerGetAudience } from "./get-audience.js";
import { registerGetAudiences } from "./get-audiences.js";
import { registerGetAutoReload } from "./get-auto-reload.js";
import { registerGetBillingAlerts } from "./get-billing-alerts.js";
import { registerListCalls } from "./get-call-logs.js";
import { registerGetBranchDraft } from "./get-branch-draft.js";
import { registerGetCampaign } from "./get-campaign.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetCreditBalance } from "./get-credit-balance.js";
import { registerGetCreditLedger } from "./get-credit-ledger.js";
import { registerGetInvoices } from "./get-invoices.js";
import { registerGetPaymentMethods } from "./get-payment-methods.js";
import { registerGetPhoneNumbers } from "./get-phone-numbers.js";
import { registerGetPlans } from "./get-plans.js";
import { registerGetRevision } from "./get-revision.js";
import { registerGetUsageBreakdown } from "./get-usage-breakdown.js";
import { registerGetUsageStats } from "./get-usage-stats.js";
import { registerGetVoices } from "./get-voices.js";
import { registerInviteMember } from "./invite-member.js";
import { registerListBranches } from "./list-branches.js";
import { registerListRevisions } from "./list-revisions.js";
import { registerMakeBranchLive } from "./make-branch-live.js";
import { registerMakeCall } from "./make-call.js";
import { registerPauseCampaign } from "./pause-campaign.js";
import {
  registerAddPlaybooks,
  registerConfigurePlaybooks,
  registerGetPlaybooks,
  registerUpdatePlaybook,
} from "./playbooks.js";
import { registerPublishDraft } from "./publish-draft.js";
import { registerRedeemCoupon } from "./redeem-coupon.js";
import { registerRemoveAgentTool } from "./remove-agent-tool.js";
import { registerRenameBranch } from "./rename-branch.js";
import { registerSearchAudienceMembers } from "./search-audience-members.js";
import { registerStartCampaign } from "./start-campaign.js";
import { registerTestAgent } from "./test-agent.js";
import { registerTextToSpeech } from "./text-to-speech.js";
import { registerTranscribeAudio } from "./transcribe-audio.js";
import { registerUpdateAgent } from "./update-agent.js";
import { registerUpdateBillingAlerts } from "./update-billing-alerts.js";
import { registerValidateCoupon } from "./validate-coupon.js";

export function registerTools(server: McpServer) {
  // Agent CRUD & editing
  registerGetAgents(server);
  registerGetAgent(server);
  registerGetAgentPrompt(server);
  registerCreateAgent(server);
  registerUpdateAgent(server);
  registerAddAgentTool(server);
  registerRemoveAgentTool(server);
  registerConfigureCallActions(server);
  registerDeleteAgent(server);
  registerDuplicateAgent(server);

  // Playbooks (multi-agent SOP orchestration)
  registerGetPlaybooks(server);
  registerAddPlaybooks(server);
  registerUpdatePlaybook(server);
  registerConfigurePlaybooks(server);

  // Versioning v2 — branches, drafts, revisions
  registerListBranches(server);
  registerCreateBranch(server);
  registerRenameBranch(server);
  registerDeleteBranch(server);
  registerMakeBranchLive(server);
  registerGetBranchDraft(server);
  registerPublishDraft(server);
  registerListRevisions(server);
  registerGetRevision(server);
  registerDiff(server);
  registerTestAgent(server);

  // Audiences
  registerGetAudiences(server);
  registerGetAudience(server);
  registerDeleteAudience(server);
  registerGetAudienceMembers(server);
  registerSearchAudienceMembers(server);
  registerAddAudienceMembers(server);
  registerDeleteAudienceMembers(server);

  // Campaigns
  registerGetCampaigns(server);
  registerGetCampaign(server);
  registerCreateCampaign(server);
  registerStartCampaign(server);
  registerPauseCampaign(server);
  registerDeleteCampaign(server);
  registerExportCampaignLogs(server);

  // Calls
  registerListCalls(server);
  registerMakeCall(server);
  registerChatWithAgent(server);
  registerDebugCall(server);
  registerGetUsageStats(server);

  // Billing & payments
  registerGetCreditBalance(server);
  registerGetCreditLedger(server);
  registerGetUsageBreakdown(server);
  registerGetInvoices(server);
  registerGetPaymentMethods(server);
  registerGetAutoReload(server);
  registerGetBillingAlerts(server);
  registerUpdateBillingAlerts(server);
  registerGetPlans(server);
  registerValidateCoupon(server);
  registerRedeemCoupon(server);

  // Utilities
  registerGetPhoneNumbers(server);
  registerGetVoices(server);
  registerAnalyticsTools(server);
  registerTextToSpeech(server);
  registerTranscribeAudio(server);
  registerInviteMember(server);
}
