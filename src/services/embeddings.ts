import type { Env } from "../index"

interface EmbeddingResponse {
  data?: unknown
}

export async function createEmbedding(env: Pick<Env, "AI">, text: string) {
  try {
    const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text
    }) as EmbeddingResponse

    const vector =
      Array.isArray(result.data) && Array.isArray(result.data[0])
        ? result.data[0].filter(isFiniteNumber)
        : []

    if (!vector.length) {
      throw new Error("Embedding response did not include a vector.")
    }

    return vector
  } catch (error) {
    throw new Error("Embedding request failed.", {
      cause: error
    })
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
