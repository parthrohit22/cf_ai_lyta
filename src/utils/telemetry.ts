/** Content-free operational telemetry suitable for aggregation at the edge. */
export function recordOperation(input: {
  route: string
  outcome: "allowed" | "limited" | "failure"
  durationMs: number
  units: number
  model?: string
  modelVersion?: string
  timedOut?: boolean
  usedFallback?: boolean
  retryCount?: number
}) {
  console.log(
    "[lyta-operation]",
    JSON.stringify({
      route: input.route,
      outcome: input.outcome,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      requestCount: 1,
      estimatedSpendUnits: Math.max(0, Math.round(input.units)),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelVersion ? { modelVersion: input.modelVersion } : {}),
      ...(input.timedOut ? { timedOut: true } : {}),
      ...(input.usedFallback ? { usedFallback: true } : {}),
      ...(input.retryCount ? { retryCount: input.retryCount } : {})
    })
  )
}
