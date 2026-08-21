import assert from "node:assert/strict"
import { test } from "node:test"
import { Conversation } from "../../src/durable/conversation"
import type { ChatMessageRecord } from "../../src/chat/messages"

function createConversation() {
  const values = new Map<string, unknown>()
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => values.set(key, value),
      deleteAll: async () => values.clear()
    }
  }

  return {
    values,
    conversation: new Conversation(state as unknown as DurableObjectState, {} as never)
  }
}

test("canonical history preserves 20+ ordered messages when summary generation fails", async () => {
  const { conversation } = createConversation()
  const messages: ChatMessageRecord[] = Array.from({ length: 22 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    ...(index === 0
      ? {
          attachments: [
            {
              id: "attachment-1",
              kind: "document",
              name: "notes.txt",
              mimeType: "text/plain",
              size: 8,
              extractedText: "source"
            }
          ],
          citations: [{ id: "chunk-1", label: "Source 1", fileId: "file-1", fileName: "notes.txt", snippet: "source" }]
        }
      : {})
  }))

  const original = console.error
  console.error = () => undefined
  try {
    await conversation.persistConversation(messages)
  } finally {
    console.error = original
  }

  const response = await conversation.fetch(new Request("https://internal/history"))
  const body = (await response.json()) as { messages: ChatMessageRecord[] }
  assert.equal(body.messages.length, 22)
  assert.deepEqual(
    body.messages.map((message) => message.id),
    messages.map((message) => message.id)
  )
  assert.deepEqual(body.messages[0].attachments, messages[0].attachments)
  assert.deepEqual(body.messages[0].citations, messages[0].citations)
})

test("legacy recent records backfill into canonical history without mutation", async () => {
  const { conversation, values } = createConversation()
  const legacy: ChatMessageRecord[] = [{ role: "user", content: "legacy", createdAt: "2026-01-01T00:00:00.000Z" }]
  values.set("recent", legacy)

  const response = await conversation.fetch(new Request("https://internal/history"))
  const body = (await response.json()) as { messages: ChatMessageRecord[] }
  assert.deepEqual(body.messages, legacy)
  assert.deepEqual(values.get("messages"), legacy)
})
