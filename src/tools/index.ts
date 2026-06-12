import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerActivateVersion } from "./activate-version.js";
import { registerAddAgentTool } from "./add-agent-tool.js";
import { registerAddAudienceMembers } from "./add-audience-members.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerCompareVersionMetrics } from "./compare-version-metrics.js";
import { registerCreateAgent } from "./create-agent.js";
import { registerCreateCampaign } from "./create-campaign.js";
import { registerDebugCall } from "./debug-call.js";
import { registerDeleteAgent } from "./delete-agent.js";
import { registerDeleteAudienceMembers } from "./delete-audience-members.js";
import { registerDeleteAudience } from "./delete-audience.js";
import { registerDeleteCampaign } from "./delete-campaign.js";
import { registerDiffVersions } from "./diff-versions.js";
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
import { registerGetCampaign } from "./get-campaign.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetCreditBalance } from "./get-credit-balance.js";
import { registerGetCreditLedger } from "./get-credit-ledger.js";
import { registerGetDraftDiff } from "./get-draft-diff.js";
import { registerGetDraft } from "./get-draft.js";
import { registerGetInvoices } from "./get-invoices.js";
import { registerGetPaymentMethods } from "./get-payment-methods.js";
import { registerGetPhoneNumbers } from "./get-phone-numbers.js";
import { registerGetPlans } from "./get-plans.js";
import { registerGetUsageBreakdown } from "./get-usage-breakdown.js";
import { registerGetUsageStats } from "./get-usage-stats.js";
import { registerGetVersion } from "./get-version.js";
import { registerGetVoices } from "./get-voices.js";
import { registerInviteMember } from "./invite-member.js";
import { registerListDrafts } from "./list-drafts.js";
import { registerListVersions } from "./list-versions.js";
import { registerMakeCall } from "./make-call.js";
import { registerPauseCampaign } from "./pause-campaign.js";
import { registerPublishDraft } from "./publish-draft.js";
import { registerRedeemCoupon } from "./redeem-coupon.js";
import { registerRemoveAgentTool } from "./remove-agent-tool.js";
import { registerRenameDraft } from "./rename-draft.js";
import { registerSearchAudienceMembers } from "./search-audience-members.js";
import { registerSetPreCallApi } from "./set-pre-call-api.js";
import { registerStartCampaign } from "./start-campaign.js";
import { registerTestDraft } from "./test-draft.js";
import { registerTestVersion } from "./test-version.js";
import { registerTextToSpeech } from "./text-to-speech.js";
import { registerTranscribeAudio } from "./transcribe-audio.js";
import { registerUpdateAgentConfig } from "./update-agent-config.js";
import { registerUpdateAgentPrompt } from "./update-agent-prompt.js";
import { registerUpdateBillingAlerts } from "./update-billing-alerts.js";
import { registerUpdateVersion } from "./update-version.js";
import { registerValidateCoupon } from "./validate-coupon.js";

export function registerTools(server: McpServer) {
  // Agent CRUD
  registerGetAgents(server);
  registerGetAgent(server);
  registerGetAgentPrompt(server);
  registerCreateAgent(server);
  registerUpdateAgentPrompt(server);
  registerUpdateAgentConfig(server);
  registerAddAgentTool(server);
  registerRemoveAgentTool(server);
  registerSetPreCallApi(server);
  registerDeleteAgent(server);
  registerDuplicateAgent(server);

  // Drafts
  registerListDrafts(server);
  registerGetDraft(server);
  registerRenameDraft(server);
  registerGetDraftDiff(server);
  registerPublishDraft(server);
  registerTestDraft(server);

  // Published versions
  registerListVersions(server);
  registerGetVersion(server);
  registerUpdateVersion(server);
  registerActivateVersion(server);
  registerDiffVersions(server);
  registerCompareVersionMetrics(server);
  registerTestVersion(server);

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
