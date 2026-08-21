import type { ChatMode } from "../chat/messages"

export interface ModelProfile {
  /** Workers AI model id passed to env.AI.run(). */
  model: string
  /** Human-readable version label recorded in telemetry; bump when the underlying model changes. */
  modelVersion: string
  /** Tried once, after primary retries are exhausted, before the call is reported as failed. */
  fallbackModel?: string
  timeoutMs: number
  maxRetries: number
  temperature: number
  top_p: number
  max_tokens: number
  targets: {
    latencyMsP50: number
    latencyMsP95: number
    estimatedCostPerRequestUsd: number
    qualityNotes: string
  }
}

/**
 * Single source of truth for per-mode model selection and policy. Changing a
 * value here changes production behavior for that mode's next request — see
 * RELEASE_CHECKLIST.md's AI-evaluation comparison step before promoting a
 * change, and eval/README.md for the pass-rate gate CI enforces.
 */
export const MODEL_PROFILES: Record<ChatMode, ModelProfile> = {
  instant: {
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    modelVersion: "llama-4-scout-17b-16e-instruct",
    fallbackModel: "@cf/meta/llama-3.1-8b-instruct",
    timeoutMs: 12_000,
    maxRetries: 1,
    temperature: 0.45,
    top_p: 0.9,
    max_tokens: 1100,
    targets: {
      latencyMsP50: 2_000,
      latencyMsP95: 6_000,
      estimatedCostPerRequestUsd: 0.002,
      qualityNotes: "Quick, direct answers for short technical questions. Some depth/nuance loss is acceptable for speed."
    }
  },
  deep: {
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    modelVersion: "llama-4-scout-17b-16e-instruct",
    fallbackModel: "@cf/meta/llama-3.1-8b-instruct",
    timeoutMs: 25_000,
    maxRetries: 1,
    temperature: 0.35,
    top_p: 0.85,
    max_tokens: 1800,
    targets: {
      latencyMsP50: 5_000,
      latencyMsP95: 15_000,
      estimatedCostPerRequestUsd: 0.004,
      qualityNotes:
        "Deep Review: prioritizes evidence grounding and completeness over speed. Every claim should be traceable to retrieved context or explicitly flagged as unsupported."
    }
  },
  creative: {
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    modelVersion: "llama-4-scout-17b-16e-instruct",
    fallbackModel: "@cf/meta/llama-3.1-8b-instruct",
    timeoutMs: 18_000,
    maxRetries: 1,
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: 1400,
    targets: {
      latencyMsP50: 3_500,
      latencyMsP95: 10_000,
      estimatedCostPerRequestUsd: 0.003,
      qualityNotes: "Exploratory/brainstorming responses. Not currently in #6's required scope; documented for consistency."
    }
  }
}

export function getModelProfile(mode: ChatMode): ModelProfile {
  return MODEL_PROFILES[mode] || MODEL_PROFILES.instant
}
