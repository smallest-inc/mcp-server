import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerActivateVersion } from "./activate-version.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerCompareVersionMetrics } from "./compare-version-metrics.js";
import { registerCreateAgent } from "./create-agent.js";
import { registerDebugCall } from "./debug-call.js";
import { registerDeleteAgent } from "./delete-agent.js";
import { registerDiffVersions } from "./diff-versions.js";
import { registerDuplicateAgent } from "./duplicate-agent.js";
import { registerGetAgent } from "./get-agent.js";
import { registerGetAgentPrompt } from "./get-agent-prompt.js";
import { registerGetAgents } from "./get-agents.js";
import { registerGetAutoReload } from "./get-auto-reload.js";
import { registerGetBillingAlerts } from "./get-billing-alerts.js";
import { registerListCalls } from "./get-call-logs.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetCreditBalance } from "./get-credit-balance.js";
import { registerGetCreditLedger } from "./get-credit-ledger.js";
import { registerGetDraftDiff } from "./get-draft-diff.js";
import { registerGetDraft } from "./get-draft.js";
import { registerGetFeatures } from "./get-features.js";
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
import { registerPublishDraft } from "./publish-draft.js";
import { registerRedeemCoupon } from "./redeem-coupon.js";
import { registerRenameDraft } from "./rename-draft.js";
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

  // Calls & campaigns
  registerListCalls(server);
  registerMakeCall(server);
  registerDebugCall(server);
  registerGetCampaigns(server);
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
  registerGetFeatures(server);
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
