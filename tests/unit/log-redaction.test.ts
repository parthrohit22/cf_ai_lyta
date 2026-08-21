import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { test } from "node:test"

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url))

// Every failure path must log through logServerError()/recordOperation(), which
// enforce an allowlist of safe metadata keys (see src/utils/serverErrors.ts).
// A raw console.log/error/warn call bypasses that allowlist and can leak
// credentials, prompts, document text, or user identifiers into logs.
const ALLOWLISTED_FILES = new Set(["utils/serverErrors.ts", "utils/telemetry.ts"])
const RAW_CONSOLE_CALL = /console\.(log|error|warn)\(/

function collectTsFiles(dir: string, relativeTo: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const relativePath = relativeTo ? `${relativeTo}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...collectTsFiles(path.join(dir, entry.name), relativePath))
      continue
    }

    if (entry.name.endsWith(".ts")) {
      files.push(relativePath)
    }
  }

  return files
}

test("no source file outside the allowlisted logging utilities calls console.log/error/warn directly", () => {
  const offenders: string[] = []

  for (const relativePath of collectTsFiles(SRC_ROOT, "")) {
    if (ALLOWLISTED_FILES.has(relativePath)) {
      continue
    }

    const contents = readFileSync(path.join(SRC_ROOT, relativePath), "utf8")

    if (RAW_CONSOLE_CALL.test(contents)) {
      offenders.push(relativePath)
    }
  }

  assert.deepEqual(offenders, [], "route failures through logServerError()/recordOperation() instead of a raw console call")
})
