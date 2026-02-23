/**
 * Local type definitions for the MCP server.
 * These match the shapes returned by the Atoms platform API.
 */

// ─── Agent Types ──────────────────────────────────────────────────────────────

export interface LanguageConfig {
  default: string;
  supported: string[];
  switching: {
    isEnabled: boolean;
    minWordsForDetection: number;
    strongSignalThreshold: number;
    weakSignalThreshold: number;
    minConsecutiveForWeakThresholdSwitch: number;
  };
}

export interface SynthesizerVoiceConfig {
  model: string;
  voiceId: string;
  gender?: string;
}

export interface SynthesizerConfig {
  voiceConfig: SynthesizerVoiceConfig;
  speed: number;
  consistency?: number;
  similarity?: number;
  enhancement?: number;
  sampleRate?: number;
}

export interface IAgentDTO {
  _id: string;
  name: string;
  description: string;
  slmModel: string;
  synthesizer: SynthesizerConfig;
  language: LanguageConfig;
  allowInboundCall?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  firstMessage?: string;
  workflowId: string;
  workflowType?: string;
  backgroundSound: string;
  smartTurnConfig?: {
    isEnabled: boolean;
    waitTimeInSecs: number;
  };
  denoisingConfig?: {
    isEnabled: boolean;
  };
  redactionConfig: {
    isEnabled: boolean;
  };
  totalCalls?: number;
  globalPrompt?: string;
}

// ─── Campaign Types ───────────────────────────────────────────────────────────

export interface ICampaignDTO {
  _id: string;
  name: string;
  status: string;
  agent: {
    _id: string;
    name: string;
  };
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Call Log Types ───────────────────────────────────────────────────────────

/** Response entry from GET /analytics/call-counts-log */
export interface ICallCountsLogEntry {
  callId: string;
  callType: string;
  callStatus: string;
  callDurationMs?: number;
  costSpent?: number;
  fromNumber?: string;
  toNumber?: string;
  agentName?: string;
  campaignName?: string;
  disconnectionReason?: string;
  timestamp?: string;
  recordingUrl?: string;
}

// ─── Phone Number Types ───────────────────────────────────────────────────────

/** Response entry from GET /product/phone-numbers */
export interface IPhoneNumberEntry {
  _id: string;
  productType?: string;
  agentId?: string;
  agent?: { name?: string; _id?: string };
  isActive?: boolean;
  attributes?: {
    phoneNumber?: string;
    countryCode?: string;
    provider?: string;
    areaCode?: string;
  };
  // Fallback fields for alternative response shapes
  phoneNumber?: string;
  country?: string;
}
