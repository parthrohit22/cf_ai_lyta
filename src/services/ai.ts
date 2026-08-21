import type { Env } from "../index"
import type { ChatMode } from "../chat/messages"

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"

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

function getModelSettings(mode: ChatMode | undefined) {
  switch (mode) {
    case "deep":
      return {
        temperature: 0.35,
        top_p: 0.85,
        max_tokens: 1800
      }
    case "creative":
      return {
        temperature: 0.9,
        top_p: 0.95,
        max_tokens: 1400
      }
    default:
      return {
        temperature: 0.45,
        top_p: 0.9,
        max_tokens: 1100
      }
  }
}

export async function runAI(env: Pick<Env, "AI">, messages: AiChatMessage[], options?: RunAIOptions) {
  try {
    const result = await env.AI.run(MODEL, {
      messages,
      ...getModelSettings(options?.mode)
    })

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
  try {
    const stream = await env.AI.run(MODEL, {
      messages,
      ...getModelSettings(options?.mode),
      stream: true
    })

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
