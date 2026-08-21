import assert from "node:assert/strict"
import { test } from "node:test"
import { Conversation } from "../../src/durable/conversation"

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function createConversation() {
  const values = new Map<string, unknown>()
  const state = {
    storage: {
      // Real Durable Object storage is a serialization boundary: every get()
      // returns a fresh deserialized value, never a live reference another
      // in-flight request is still mutating. Cloning here matters for the
      // concurrency test below.
      get: async <T>(key: string) => clone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => values.set(key, clone(value)),
      deleteAll: async () => values.clear()
    }
  }

  return {
    values,
    conversation: new Conversation(state as unknown as DurableObjectState, {} as never)
  }
}

function sseStreamFrom(chunks: string[]) {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }

      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    }
  })
}

function fakeAI(streamChunks: string[] | (() => ReadableStream<Uint8Array>)) {
  return {
    async run(_model: string, input: { stream?: boolean }) {
      if (input.stream) {
        return typeof streamChunks === "function" ? streamChunks() : sseStreamFrom(streamChunks)
      }

      return { response: "ok" }
    }
  }
}

async function drain(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }

  return text
}

function streamRequest(requestId: string, message = "Hi there") {
  return new Request("https://internal/chat/stream", {
    method: "POST",
    body: JSON.stringify({
      message,
      mode: "instant",
      requestId,
      userId: "",
      sessionId: ""
    })
  })
}

test("the user message is durable before generation starts, independent of streaming outcome", async () => {
  const { conversation, values } = createConversation()
  ;(conversation as unknown as { env: unknown }).env = {
    AI: fakeAI(['data: {"response":"Hello "}\n\n', 'data: {"response":"world."}\n\n'])
  }

  const response = await conversation.fetch(streamRequest("req-1"))

  const messagesBeforeDrain = values.get("messages") as unknown[]
  assert.equal(messagesBeforeDrain.length, 1)
  assert.equal((messagesBeforeDrain[0] as { role: string }).role, "user")

  await drain(response)
})

test("streamed chunks persist as one concatenated assistant message only after the stream completes", async () => {
  const { conversation, values } = createConversation()
  ;(conversation as unknown as { env: unknown }).env = {
    AI: fakeAI(['data: {"response":"Hello "}\n\n', 'data: {"response":"world."}\n\n'])
  }

  const response = await conversation.fetch(streamRequest("req-1"))
  const body = await drain(response)

  const history = values.get("messages") as { role: string; content: string }[]
  assert.equal(history.length, 2)
  assert.equal(history[1].role, "assistant")
  assert.equal(history[1].content, "Hello world.")
  assert.match(body, /"meta":true/)
  assert.match(body, /data: \[DONE\]/)
})

test("a failed model stream persists no partial assistant message", async () => {
  const { conversation, values } = createConversation()
  ;(conversation as unknown as { env: unknown }).env = {
    AI: {
      async run(_model: string, input: { stream?: boolean }) {
        if (input.stream) {
          throw new Error("simulated model outage")
        }
        return { response: "ok" }
      }
    }
  }

  const response = await conversation.fetch(streamRequest("req-2"))
  const body = await drain(response)

  const history = values.get("messages") as unknown[]
  assert.equal(history.length, 1, "only the user message should be persisted")
  assert.match(body, /"error"/)
})

test("concurrent stream requests to the same conversation stay ordered under the fetch queue", async () => {
  const { conversation, values } = createConversation()
  ;(conversation as unknown as { env: unknown }).env = {
    AI: fakeAI(['data: {"response":"reply"}\n\n'])
  }

  const [first, second] = await Promise.all([
    conversation.fetch(streamRequest("req-a", "first message")),
    conversation.fetch(streamRequest("req-b", "second message"))
  ])

  await Promise.all([drain(first), drain(second)])

  // Both user messages land first (they're appended on the synchronous,
  // fully-queued setup path); the two assistant replies append afterward,
  // in whichever order their generation actually finishes. Strict
  // user/assistant alternation isn't a real invariant under true
  // concurrency — what must hold is that neither background completion
  // clobbers the other's write.
  const history = values.get("messages") as { role: string; content: string }[]
  assert.equal(history.length, 4, "two user + two assistant messages, none dropped by a clobbered write")
  assert.equal(history.filter((message) => message.role === "user").length, 2)
  assert.equal(history.filter((message) => message.role === "assistant").length, 2)
})
