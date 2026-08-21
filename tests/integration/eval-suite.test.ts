import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { router } from "../../src/router"
import { Workspace } from "../../src/durable/workspace"
import { Conversation } from "../../src/durable/conversation"
import { AuthDirectory } from "../../src/durable/authDirectory"
import { RateLimiter } from "../../src/durable/rateLimiter"
import type { Env } from "../../src/index"

// This is a pipeline-correctness regression suite, NOT a live model-quality
// judge: the fake env.AI below returns each case's scripted `modelReply`
// rather than a real model's output, so it proves retrieval/citation wiring
// stays correct across changes — it cannot tell you a candidate model is
// actually "better." See eval/README.md for the promotion policy and how to
// run this dataset against a real model manually before promoting one.

interface EvalCase {
  id: string
  category: "citation-accuracy" | "insufficient-evidence" | "general-quality"
  mode: "instant" | "deep" | "creative"
  sourceDocument: { name: string; text: string } | null
  question: string
  modelReply: string
  expectCitation: boolean
  mustContainPhrase?: string
}

interface EvalDataset {
  version: string
  baselinePassRate: number
  cases: EvalCase[]
}

const dataset = JSON.parse(readFileSync(new URL("../../eval/dataset.json", import.meta.url), "utf8")) as EvalDataset

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

function createEvalEnv(modelReply: string) {
  const env = {} as Env

  Object.assign(env, {
    AI: {
      async run(model: string, input: { stream?: boolean }) {
        if (model.includes("bge")) {
          return { data: [[1, 0, 0]] }
        }
        if (input.stream) {
          throw new Error("eval-suite cases only exercise the non-streaming /chat path")
        }
        return { response: modelReply }
      }
    },
    ARTIFACTS: {
      put: async () => null,
      delete: async () => undefined
    },
    AUTH_DIRECTORY: createFakeNamespace(() => new AuthDirectory(createDurableState())),
    WORKSPACE: createFakeNamespace(() => new Workspace(createDurableState(), env)),
    CONVERSATION: createFakeNamespace(() => new Conversation(createDurableState(), env)),
    RATE_LIMITER: createFakeNamespace(() => new RateLimiter(createDurableState())),
    SESSION_INDEX: createFakeNamespace(() => ({ fetch: async () => new Response("Not Found", { status: 404 }) }))
  } satisfies Omit<Env, never>)

  return env
}

function extractCookie(response: Response, name: string) {
  const setCookie = response.headers.get("Set-Cookie") || ""
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`))
  return match ? `${name}=${match[1]}` : ""
}

async function runCase(evalCase: EvalCase) {
  const env = createEvalEnv(evalCase.modelReply)

  const registerResponse = await router(
    new Request("https://internal/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: `${evalCase.id}@eval.test`, password: "eval-suite-password" })
    }),
    env
  )
  const authCookie = extractCookie(registerResponse, "lyta_auth")

  const authedRequest = (url: string, init: RequestInit = {}) =>
    router(new Request(url, { ...init, headers: { ...(init.headers || {}), Cookie: authCookie, "Content-Type": "application/json" } }), env)

  const sessionResponse = await authedRequest("https://internal/sessions/create", { method: "POST" })
  const { session } = (await sessionResponse.json()) as { session: { id: string } }

  if (evalCase.sourceDocument) {
    await authedRequest("https://internal/library/import", {
      method: "POST",
      body: JSON.stringify({
        attachments: [
          {
            kind: "document",
            name: evalCase.sourceDocument.name,
            mimeType: "text/plain",
            size: evalCase.sourceDocument.text.length,
            extractedText: evalCase.sourceDocument.text
          }
        ]
      })
    })
  }

  const chatResponse = await authedRequest(`https://internal/chat?session=${session.id}`, {
    method: "POST",
    body: JSON.stringify({ message: evalCase.question, mode: evalCase.mode })
  })

  const body = (await chatResponse.json()) as { reply: string; citations: unknown[] }

  const failures: string[] = []

  if (chatResponse.status !== 200) {
    failures.push(`expected 200, got ${chatResponse.status}`)
  }
  if (!body.reply?.trim()) {
    failures.push("reply was empty")
  }
  if (evalCase.expectCitation && body.citations.length === 0) {
    failures.push("expected at least one citation, got none")
  }
  if (!evalCase.expectCitation && body.citations.length > 0) {
    failures.push(`expected no citations, got ${body.citations.length}`)
  }
  if (evalCase.mustContainPhrase && !body.reply.includes(evalCase.mustContainPhrase)) {
    failures.push(`reply did not contain required phrase "${evalCase.mustContainPhrase}"`)
  }

  return { id: evalCase.id, category: evalCase.category, passed: failures.length === 0, failures }
}

test(`eval suite (version ${dataset.version}) meets its documented baseline pass rate`, async () => {
  assert.ok(dataset.cases.length >= 15, `dataset must have at least 15 cases, found ${dataset.cases.length}`)

  const results = []
  for (const evalCase of dataset.cases) {
    results.push(await runCase(evalCase))
  }

  const passed = results.filter((result) => result.passed)
  const failed = results.filter((result) => !result.passed)
  const passRate = passed.length / results.length

  console.log(`[lyta-eval] ${passed.length}/${results.length} cases passed (${(passRate * 100).toFixed(1)}%)`)
  for (const failure of failed) {
    console.log(`[lyta-eval] FAILED ${failure.id} (${failure.category}): ${failure.failures.join("; ")}`)
  }

  assert.ok(
    passRate >= dataset.baselinePassRate,
    `pass rate ${(passRate * 100).toFixed(1)}% is below the documented baseline of ${(dataset.baselinePassRate * 100).toFixed(1)}%`
  )
})
