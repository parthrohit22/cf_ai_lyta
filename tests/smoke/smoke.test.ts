import assert from "node:assert/strict"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import type { Env } from "../../src/index"

// A focused, credential-free smoke test for issue #9: exercises the real
// router() entrypoint end-to-end (the same one src/index.ts calls) with the
// real Durable Object classes wired together in-process, so it proves the
// full request pipeline works without needing wrangler dev, a network call,
// or Cloudflare credentials in CI.

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function createDurableState() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async <T>(key: string) => clone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => values.set(key, clone(value)),
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
      },
      deleteAll: async () => values.clear(),
      list: async <T>({ prefix }: { prefix?: string } = {}) =>
        new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix))) as Map<string, T>,
      setAlarm: async () => undefined
    }
  } as unknown as DurableObjectState
}

function createFakeNamespace(createInstance: () => { fetch: (request: Request) => Promise<Response> }) {
  const instances = new Map<string, { fetch: (request: Request) => Promise<Response> }>()

  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!instances.has(id)) {
        instances.set(id, createInstance())
      }

      const instance = instances.get(id)!

      return {
        fetch: async (input: RequestInfo, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init))
      }
    }
  } as unknown as DurableObjectNamespace
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

function createFakeAI() {
  return {
    async run(model: string, input: { stream?: boolean }) {
      if (model.includes("bge")) {
        return { data: [[1, 0, 0]] }
      }

      if (input.stream) {
        return sseStreamFrom(['data: {"response":"Smoke test streamed reply."}\n\n'])
      }

      return { response: "Smoke test reply." }
    }
  }
}

function createSmokeEnv() {
  const artifacts = new Map<string, string>()
  const env = {} as Env

  Object.assign(env, {
    AI: createFakeAI(),
    ARTIFACTS: {
      put: async (key: string, value: string) => {
        artifacts.set(key, value)
        return null
      },
      delete: async (key: string) => {
        artifacts.delete(key)
      }
    },
    AUTH_DIRECTORY: createFakeNamespace(() => new AuthDirectory(createDurableState())),
    WORKSPACE: createFakeNamespace(() => new Workspace(createDurableState(), env)),
    CONVERSATION: createFakeNamespace(() => new Conversation(createDurableState(), env)),
    RATE_LIMITER: createFakeNamespace(() => new RateLimiter(createDurableState())),
    SESSION_INDEX: createFakeNamespace(() => ({ fetch: async () => new Response("Not Found", { status: 404 }) }))
  } satisfies Omit<Env, never>)

  return { env, artifacts }
}

function extractCookie(response: Response, name: string) {
  const setCookie = response.headers.get("Set-Cookie") || ""
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`))
  return match ? `${name}=${match[1]}` : ""
}

async function drainSse(response: Response) {
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

test("register, upload, chat, and stream round-trip through the real router with security headers intact", async () => {
  const { env } = createSmokeEnv()

  const registerResponse = await router(
    new Request("https://internal/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "smoke@example.test", password: "correct horse battery", name: "Smoke Tester" })
    }),
    env
  )
  assert.equal(registerResponse.status, 200)
  assert.ok(registerResponse.headers.get("Content-Security-Policy"), "security headers must reach every response")

  const authCookie = extractCookie(registerResponse, "lyta_auth")
  assert.ok(authCookie, "registration must issue an auth cookie")

  const authedRequest = (url: string, init: RequestInit = {}) =>
    router(
      new Request(url, {
        ...init,
        headers: { ...(init.headers || {}), Cookie: authCookie, "Content-Type": "application/json" }
      }),
      env
    )

  const sessionResponse = await authedRequest("https://internal/sessions/create", { method: "POST" })
  assert.equal(sessionResponse.status, 200)
  const { session } = (await sessionResponse.json()) as { session: { id: string } }
  assert.ok(session?.id)

  const importResponse = await authedRequest("https://internal/library/import", {
    method: "POST",
    body: JSON.stringify({
      attachments: [
        {
          kind: "document",
          name: "smoke-fixture.txt",
          mimeType: "text/plain",
          size: 40,
          extractedText: "LYTA smoke test fixture content for retrieval."
        }
      ]
    })
  })
  assert.equal(importResponse.status, 200)
  const { files } = (await importResponse.json()) as { files: Array<{ libraryFileId: string }> }
  assert.equal(files.length, 1)

  const chatResponse = await authedRequest(`https://internal/chat?session=${session.id}`, {
    method: "POST",
    body: JSON.stringify({ message: "What does the fixture say?", mode: "instant" })
  })
  assert.equal(chatResponse.status, 200)
  assert.ok(chatResponse.headers.get("Content-Security-Policy"))
  const chatBody = (await chatResponse.json()) as { reply: string; citations: unknown[] }
  assert.ok(chatBody.reply)
  assert.equal(chatBody.citations.length, 1, "the imported fixture should be cited")

  const streamResponse = await authedRequest(`https://internal/chat/stream?session=${session.id}`, {
    method: "POST",
    body: JSON.stringify({ message: "Summarize it again", mode: "instant" })
  })
  assert.equal(streamResponse.status, 200)
  assert.equal(streamResponse.headers.get("Content-Type"), "text/event-stream")
  const streamed = await drainSse(streamResponse)
  assert.match(streamed, /Smoke test streamed reply\./)
  assert.match(streamed, /data: \[DONE\]/)

  const historyResponse = await authedRequest(`https://internal/history?session=${session.id}`)
  const { messages } = (await historyResponse.json()) as { messages: Array<{ role: string }> }
  assert.equal(messages.filter((message) => message.role === "assistant").length, 2, "both replies persisted")

  const deleteResponse = await authedRequest("https://internal/library/delete", {
    method: "POST",
    body: JSON.stringify({ id: files[0].libraryFileId })
  })
  assert.equal(deleteResponse.status, 200)

  const logoutResponse = await authedRequest("https://internal/auth/logout", { method: "POST" })
  assert.equal(logoutResponse.status, 200)
})
