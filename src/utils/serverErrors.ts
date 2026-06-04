const MAX_ERROR_MESSAGE_LENGTH = 240
const MAX_LOG_VALUE_LENGTH = 120

export function getSafeErrorMessage(
  error: unknown,
  fallback = "Unexpected server error."
) {
  if (error instanceof Error && error.message.trim()) {
    return normalizeLogString(error.message, MAX_ERROR_MESSAGE_LENGTH)
  }

  if (typeof error === "string" && error.trim()) {
    return normalizeLogString(error, MAX_ERROR_MESSAGE_LENGTH)
  }

  return fallback
}

export function logServerError(
  scope: string,
  error: unknown,
  metadata?: Record<string, unknown>
) {
  const payload = {
    level: "error",
    scope: normalizeLogString(scope, 80),
    message: getSafeErrorMessage(error),
    cause: getSafeCauseMessage(error),
    errorName: error instanceof Error ? error.name : typeof error,
    metadata: sanitizeMetadata(metadata || {})
  }

  try {
    console.error("[lyta]", JSON.stringify(payload))
  } catch {
    console.error("[lyta]", payload.scope, payload.message)
  }
}

function getSafeCauseMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return undefined
  }

  return getSafeErrorMessage(error.cause, "")
}

export function scopedPrefix(value: string | undefined) {
  if (typeof value !== "string" || !value) {
    return ""
  }

  return value.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 16)
}

function sanitizeMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, sanitizeValue(value)])
  )
}

function sanitizeValue(value: unknown): unknown {
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }

  if (typeof value === "string") {
    return normalizeLogString(value, MAX_LOG_VALUE_LENGTH)
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length
    }
  }

  if (typeof value === "object" && value) {
    return {
      type: "object"
    }
  }

  return String(value)
}

function normalizeLogString(value: string, maxLength: number) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}
