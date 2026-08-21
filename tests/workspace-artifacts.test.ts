import assert from "node:assert/strict"
import { test } from "node:test"
import { Workspace } from "../src/durable/workspace"

test("artifact bodies live in R2 while workspace metadata, retrieval, and deletion remain durable", async () => {
  const values = new Map<string, unknown>()
  const objects = new Map<string, string>()
  const workspace = new Workspace({ storage: {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => values.set(key, value)
  } } as unknown as DurableObjectState, {
    ARTIFACTS: {
      put: async (key: string, value: string) => { objects.set(key, value); return null },
      delete: async (key: string) => { objects.delete(key) }
    }
  } as never)

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-a" }) }))
  const imported = await workspace.fetch(new Request("https://internal/library/upsert", {
    method: "POST",
    body: JSON.stringify({
      files: [{ signature: "hash-a", kind: "document", name: "notes.txt", mimeType: "text/plain", size: 10, extractedText: "private source text" }],
      chunks: [{ id: "chunk-a", fileId: "hash-a", fileName: "notes.txt", text: "private source text", vector: [1, 0] }]
    })
  }))
  const { files } = await imported.json() as { files: Array<{ libraryFileId: string }> }
  const serialized = JSON.stringify(values.get("library"))
  assert.doesNotMatch(serialized, /private source text|data:image/)
  assert.equal(objects.size, 1)

  const search = await workspace.fetch(new Request("https://internal/library/search", { method: "POST", body: JSON.stringify({ queryVector: [1, 0] }) }))
  const result = await search.json() as { citations: Array<{ fileId: string }> }
  assert.equal(result.citations[0]?.fileId, files[0].libraryFileId)

  await workspace.fetch(new Request("https://internal/library/delete", { method: "POST", body: JSON.stringify({ id: files[0].libraryFileId }) }))
  assert.equal(objects.size, 0)
  assert.equal(JSON.stringify(values.get("libraryChunks")), "[]")
})

test("legacy inline artifact payloads migrate to R2 before bootstrap returns metadata", async () => {
  const values = new Map<string, unknown>([["library", [{
    id: "file-legacy",
    signature: "legacy-hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachment: {
      kind: "image", name: "legacy.png", mimeType: "image/png", size: 12,
      dataUrl: "data:image/png;base64,legacy-payload"
    }
  }]]])
  const objects = new Map<string, string>()
  const workspace = new Workspace({ storage: {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => values.set(key, value)
  } } as unknown as DurableObjectState, {
    ARTIFACTS: {
      put: async (key: string, value: string) => { objects.set(key, value); return null },
      delete: async () => undefined
    }
  } as never)

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-legacy" }) }))
  const bootstrap = await workspace.fetch(new Request("https://internal/bootstrap"))
  const data = await bootstrap.json() as { library: Array<Record<string, unknown>> }

  assert.equal(data.library.length, 1)
  assert.doesNotMatch(JSON.stringify(values.get("library")), /legacy-payload|data:image/)
  assert.equal(objects.size, 1)
  assert.match([...objects.values()][0] || "", /legacy-payload/)
})
