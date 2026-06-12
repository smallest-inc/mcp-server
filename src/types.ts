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
  allowInterruptions?: boolean;
  waitForUserToSpeakFirst?: boolean;
  muteUserUntilFirstBotResponse?: boolean;
  interruptionBackoffTimer?: number;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  firstMessage?: string;
  workflowId: string;
  workflowType?: string;
  activeVersionId?: string | null;
  backgroundSound: string;
  smartTurnConfig?: {
    isEnabled: boolean;
    waitTimeInSecs: number;
  };
  voiceDetectionConfig?: {
    confidence: number;
    minVolume: number;
    triggerTimeInSecs: number;
    releaseTimeInSecs: number;
  };
  voiceMailDetectionConfig?: {
    enabled: boolean;
    endText: string;
  };
  denoisingConfig?: {
    isEnabled: boolean;
  };
  redactionConfig: {
    isEnabled: boolean;
  };
  defaultVariables?: Record<string, unknown>;
  globalKnowledgeBaseId?: string;
  totalCalls?: number;
  globalPrompt?: string;
  speechFormatting?: boolean;
  enableStyleGuide?: boolean;
  callDispositionConfig?: string;
  pronunciationDicts?: Array<{ word: string; pronunciation: string }>;
  llmIdleTimeoutConfig?: {
    chatTimeoutTimeInSecs: number;
    webcallTimeoutTimeInSecs: number;
    telephonyTimeoutTimeInSecs: number;
    maxRetries: number;
  };
  sessionTimeoutConfig?: {
    timeoutTimeInSecs: number;
  };
  preCallAPI?: {
    isEnabled: boolean;
    url: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    timeout: number;
    queryParams?: Record<string, unknown>;
    responseVariables: { variableName: string; jsonPath: string }[];
  };
}

// ─── Campaign Types ───────────────────────────────────────────────────────────

export interface ICampaignDTO {
  _id: string;
  name: string;
  description?: string;
  status: string;
  agent: {
    _id: string;
    name: string;
  };
  audience?: {
    _id: string;
    name: string;
  };
  participantsCount?: number;
  maxRetries?: number;
  retryAttempts?: number;
  retryDelay?: number;
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
  currentExecution?: {
    executionNumber: number;
    executionType: string;
    totalBatches: number;
    processedBatches: number;
    failedBatches: number;
    totalMembers: number;
    processedMembers: number;
    failedMembers: number;
    startedAt: string;
  };
  pausedAt?: string;
  cancelledCallsCount?: number;
  error?: string;
  failedAt?: string;
}

// ─── Call Log Types ───────────────────────────────────────────────────────────

/** Response entry from GET /analytics/call-counts-log (maps to CallLogRow from relay) */
export interface ICallCountsLogEntry {
  orgId: string;
  callId: string;
  agentId: string;
  agentName?: string;
  campaignId?: string;
  campaignName?: string;
  callType?: string;
  callStatus?: string;
  timestamp: string;
  callDurationMs: number;
  callLatencyMs?: number;
  costSpent: number;
  disconnectionReason?: string;
  source?: string;
  recordingUrl?: string;
  fromNumber?: string;
  toNumber?: string;
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
