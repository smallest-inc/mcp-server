import { wavesApi } from "./waves-api.js";

const PRO_MODEL_ID = "lightning-v3.1-pro";

/**
 * Synthesizer models whose voices are drawn from the Waves Lightning catalog and
 * may live in the Pro pool. Mirrors the backend's create/update validation, which
 * only derives a Pro modelId for these models (gpt-realtime / "other" are excluded).
 */
const WAVES_LIGHTNING_MODELS = new Set([
  "waves",
  "waves_lightning_large",
  "waves_lightning_v2",
  "waves_lightning_v3_1",
]);

/**
 * Resolve the Waves pool-routing modelId for a voice.
 *
 * Pro voices live only in the lightning-v3.1-pro pool. If the synthesizer request
 * omits modelId, Waves defaults to the standard lightning-v3.1 pool and rejects the
 * voice at call time ("Invalid Voice ID"). The dashboard sets this via its Pro voice
 * picker; the MCP must do the same or Pro voices silently downgrade and fail.
 *
 * Note: the create / direct-update backend paths re-derive this from the catalog
 * themselves, but the versioned draft-config path persists `modelId ?? null` verbatim
 * — so the MCP has to supply it for Pro voices to render on versioned agents.
 *
 * Returns "lightning-v3.1-pro" when the voice is a Pro voice on a Lightning model,
 * otherwise undefined. Best-effort: any catalog-fetch failure returns undefined so
 * voice selection never blocks agent create/update.
 */
export async function resolveProModelId(
  model: string | undefined,
  voiceId: string | undefined
): Promise<string | undefined> {
  if (!voiceId || !model || !WAVES_LIGHTNING_MODELS.has(model)) return undefined;

  try {
    const result = await wavesApi("GET", "/voice/get-all-models");
    if (!result.ok) return undefined;

    const voices = (result.data?.voices ?? []) as Array<{ voiceId: string; modelIds?: string[] }>;
    const voice = voices.find((v) => v.voiceId === voiceId);

    return voice?.modelIds?.includes(PRO_MODEL_ID) ? PRO_MODEL_ID : undefined;
  } catch {
    return undefined;
  }
}
