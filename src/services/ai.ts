import type { Env } from "../index"
import type { ChatMode } from "../chat/messages"
import { getModelProfile, type ModelProfile } from "../config/modelProfiles"
import { recordOperation } from "../utils/telemetry"

export interface AiChatMessage {
  role: "system" | "user" | "assistant"
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>
}

interface AiTextResponse {
  response?: string
}

interface RunAIOptions {
  mode?: ChatMode
}

class ModelTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError(`Model call timed out after ${timeoutMs}ms.`)), timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Timeout + bounded retry + single fallback-model attempt around a Workers AI
 * call, with the outcome recorded as non-sensitive telemetry (model/version/
 * retry/fallback/timeout — never prompt or response content). This is an
 * in-Worker policy layer, not Cloudflare AI Gateway integration (see #14).
 */
export async function callWithPolicy<T>(route: string, profile: ModelProfile, invoke: (model: string) => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  const attempts = [
    ...Array.from({ length: profile.maxRetries + 1 }, () => profile.model),
    ...(profile.fallbackModel ? [profile.fallbackModel] : [])
  ]

  let timedOut = false
  let retryCount = 0
  let lastError: unknown

  for (let index = 0; index < attempts.length; index++) {
    const model = attempts[index]
    const isFallback = Boolean(profile.fallbackModel) && index === attempts.length - 1

    if (index > 0 && !isFallback) {
      retryCount += 1
    }

    try {
      const result = await withTimeout(invoke(model), profile.timeoutMs)

      recordOperation({
        route,
        outcome: "allowed",
        durationMs: Date.now() - startedAt,
        units: 1,
        model,
        modelVersion: profile.modelVersion,
        timedOut,
        usedFallback: isFallback,
        retryCount
      })

      return result
    } catch (error) {
      lastError = error

      if (error instanceof ModelTimeoutError) {
        timedOut = true
      }
    }
  }

  recordOperation({
    route,
    outcome: "failure",
    durationMs: Date.now() - startedAt,
    units: 1,
    model: profile.model,
    modelVersion: profile.modelVersion,
    timedOut,
    retryCount
  })

  throw lastError
}

export async function runAI(env: Pick<Env, "AI">, messages: AiChatMessage[], options?: RunAIOptions) {
  const profile = getModelProfile(options?.mode || "instant")

  try {
    const result = await callWithPolicy("ai.chat", profile, (model) =>
      env.AI.run(model, {
        messages,
        temperature: profile.temperature,
        top_p: profile.top_p,
        max_tokens: profile.max_tokens
      })
    )

    if (!isObject(result)) {
      return {}
    }

    return result as AiTextResponse
  } catch (error) {
    throw new Error("Workers AI request failed.", {
      cause: error
    })
  }
}

export async function runAIStream(env: Pick<Env, "AI">, messages: AiChatMessage[], options?: RunAIOptions) {
  const profile = getModelProfile(options?.mode || "instant")

  try {
    // Policy (timeout/retry/fallback) applies only to obtaining the stream.
    // By the time a caller reads from it, streamChat() has already returned
    // the SSE Response — retrying mid-stream would mean discarding whatever
    // partial reply the client already saw, which is a real behavior change
    // out of scope here.
    const stream = await callWithPolicy("ai.chat.stream", profile, (model) =>
      env.AI.run(model, {
        messages,
        temperature: profile.temperature,
        top_p: profile.top_p,
        max_tokens: profile.max_tokens,
        stream: true
      })
    )

    if (!isReadableStream(stream)) {
      throw new Error("Workers AI did not return a readable stream.")
    }

    return stream
  } catch (error) {
    throw new Error("Workers AI stream failed.", {
      cause: error
    })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof value === "object" && typeof (value as ReadableStream<Uint8Array>).getReader === "function")
}
