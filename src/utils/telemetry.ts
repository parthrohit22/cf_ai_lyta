/** Content-free operational telemetry suitable for aggregation at the edge. */
export function recordOperation(input: { route: string; outcome: "allowed" | "limited" | "failure"; durationMs: number; units: number }) {
  console.log(
    "[lyta-operation]",
    JSON.stringify({
      route: input.route,
      outcome: input.outcome,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      requestCount: 1,
      estimatedSpendUnits: Math.max(0, Math.round(input.units))
    })
  )
}
