import assert from "node:assert/strict"
import { test } from "node:test"
import { AuthDirectory } from "../src/durable/authDirectory"
import { RateLimiter } from "../src/durable/rateLimiter"

function storageState() {
  const values = new Map<string, unknown>()
  return {
    values,
    state: { storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => values.set(key, value),
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
      },
      list: async <T>({ prefix }: { prefix?: string }) => new Map(
        [...values].filter(([key]) => !prefix || key.startsWith(prefix))
      ) as Map<string, T>,
      setAlarm: async () => undefined
    } }
  }
}

test("distributed limiter returns a retry window after its independent budget", async () => {
  const { state } = storageState()
  const limiter = new RateLimiter(state as unknown as DurableObjectState)
  const request = () => new Request("https://internal/consume", { method: "POST", body: JSON.stringify({ limit: 2, windowMs: 60_000 }) })
  assert.equal((await limiter.fetch(request())).status, 200)
  assert.equal((await limiter.fetch(request())).status, 200)
  const limited = await limiter.fetch(request())
  assert.deepEqual(await limited.json(), { allowed: false, remaining: 0, retryAfter: 60 })
})

test("auth uses keyed records and expired sessions are pruned without another login", async () => {
  const { state, values } = storageState()
  const auth = new AuthDirectory(state as unknown as DurableObjectState)
  const register = (email: string) => auth.fetch(new Request("https://internal/register", {
    method: "POST", body: JSON.stringify({ email, password: "password-123" })
  }))
  const first = await register("first@example.test")
  await register("second@example.test")
  assert.equal(values.has("usersByEmail"), false)
  assert.equal(values.has("user:first@example.test"), true)
  assert.equal(values.has("user:second@example.test"), true)
  const token = (await first.json() as { token: string }).token
  const sessionKey = [...values.keys()].find(key => key.startsWith("session:"))!
  const session = values.get(sessionKey) as { expiresAt: string }
  session.expiresAt = new Date(Date.now() - 1).toISOString()
  values.set(sessionKey, session)
  await auth.alarm()
  const validated = await auth.fetch(new Request("https://internal/session", { method: "POST", body: JSON.stringify({ token }) }))
  assert.equal(validated.status, 401)
})
