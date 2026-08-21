interface LimitRequest {
  limit?: number
  windowMs?: number
  cost?: number
}

interface LimitRecord {
  used: number
  resetAt: number
}

/** One Durable Object per endpoint/identity bucket: limits survive isolates. */
export class RateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/consume" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 })
    }

    const body = await request.json() as LimitRequest
    const limit = Math.max(1, Math.min(10_000, Math.floor(body.limit || 1)))
    const windowMs = Math.max(1_000, Math.min(86_400_000, Math.floor(body.windowMs || 60_000)))
    const cost = Math.max(1, Math.min(limit, Math.floor(body.cost || 1)))
    const now = Date.now()
    const current = await this.state.storage.get<LimitRecord>("bucket")
    const record = !current || current.resetAt <= now
      ? { used: 0, resetAt: now + windowMs }
      : current
    const allowed = record.used + cost <= limit

    if (allowed) {
      record.used += cost
      await this.state.storage.put("bucket", record)
    }

    const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000))
    return Response.json({ allowed, remaining: Math.max(0, limit - record.used), retryAfter })
  }
}
