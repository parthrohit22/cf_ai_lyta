import assert from "node:assert/strict"
import { test } from "node:test"
import { Workspace } from "../../src/durable/workspace"

test("artifact bodies live in R2 while workspace metadata, retrieval, and deletion remain durable", async () => {
  const values = new Map<string, unknown>()
  const objects = new Map<string, string>()
  const workspace = new Workspace(
    {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => values.set(key, value)
      }
    } as unknown as DurableObjectState,
    {
      ARTIFACTS: {
        put: async (key: string, value: string) => {
          objects.set(key, value)
          return null
        },
        delete: async (key: string) => {
          objects.delete(key)
        }
      }
    } as never
  )

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-a" }) }))
  const imported = await workspace.fetch(
    new Request("https://internal/library/upsert", {
      method: "POST",
      body: JSON.stringify({
        files: [
          {
            signature: "hash-a",
            kind: "document",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 10,
            extractedText: "private source text"
          }
        ],
        chunks: [{ id: "chunk-a", fileId: "hash-a", fileName: "notes.txt", text: "private source text", vector: [1, 0] }]
      })
    })
  )
  const { files } = (await imported.json()) as { files: Array<{ libraryFileId: string }> }
  const serialized = JSON.stringify(values.get("library"))
  assert.doesNotMatch(serialized, /private source text|data:image/)
  assert.equal(objects.size, 1)

  const search = await workspace.fetch(
    new Request("https://internal/library/search", { method: "POST", body: JSON.stringify({ queryVector: [1, 0] }) })
  )
  const result = (await search.json()) as { citations: Array<{ fileId: string }> }
  assert.equal(result.citations[0]?.fileId, files[0].libraryFileId)

  await workspace.fetch(
    new Request("https://internal/library/delete", { method: "POST", body: JSON.stringify({ id: files[0].libraryFileId }) })
  )
  assert.equal(objects.size, 0)
  assert.equal(JSON.stringify(values.get("libraryChunks")), "[]")
})

test("re-uploading an identical signature reuses the existing file instead of duplicating R2 storage or the library entry", async () => {
  const values = new Map<string, unknown>()
  const objects = new Map<string, string>()
  let putCount = 0
  const workspace = new Workspace(
    {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => values.set(key, value)
      }
    } as unknown as DurableObjectState,
    {
      ARTIFACTS: {
        put: async (key: string, value: string) => {
          putCount += 1
          objects.set(key, value)
          return null
        },
        delete: async (key: string) => {
          objects.delete(key)
        }
      }
    } as never
  )

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-a" }) }))

  const uploadBody = JSON.stringify({
    files: [
      {
        signature: "hash-repeat",
        kind: "document",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 10,
        extractedText: "same source text"
      }
    ],
    chunks: [{ id: "chunk-repeat", fileId: "hash-repeat", fileName: "notes.txt", text: "same source text", vector: [1, 0] }]
  })

  const first = await workspace.fetch(new Request("https://internal/library/upsert", { method: "POST", body: uploadBody }))
  const { files: firstFiles } = (await first.json()) as { files: Array<{ libraryFileId: string }> }

  assert.equal(putCount, 1)
  assert.equal((values.get("library") as unknown[]).length, 1)

  const second = await workspace.fetch(new Request("https://internal/library/upsert", { method: "POST", body: uploadBody }))
  const { files: secondFiles } = (await second.json()) as { files: Array<{ libraryFileId: string }> }

  assert.equal(putCount, 1, "R2 put should not run again for an already-stored signature")
  assert.equal(objects.size, 1)
  assert.equal((values.get("library") as unknown[]).length, 1, "reuse must not duplicate the library entry")
  assert.equal(secondFiles[0].libraryFileId, firstFiles[0].libraryFileId, "the same file record is reused, not recreated")
})

test("uploading past the library cap evicts the oldest file instead of growing storage without bound", async () => {
  const MAX_LIBRARY_FILES = 40
  const now = "2026-01-01T00:00:00.000Z"
  const seeded = Array.from({ length: MAX_LIBRARY_FILES }, (_, index) => ({
    id: `file-${index}`,
    signature: `hash-${index}`,
    contentHash: `hash-${index}`,
    workspaceScope: "workspace-a",
    objectKey: `workspaces/workspace-a/artifacts/file-${index}/hash-${index}`,
    ingestionState: "ready",
    createdAt: now,
    updatedAt: now,
    sourceVersionId: `source-version:hash-${index}`,
    retention: "until-user-delete",
    attachment: {
      id: `attachment-${index}`,
      kind: "document",
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      size: 10
    }
  }))
  // index 0 is the newest (upsertLibrary unshifts new files to the front),
  // so index MAX_LIBRARY_FILES - 1 is the oldest and the one due for eviction.
  const oldestId = seeded[seeded.length - 1].id

  const values = new Map<string, unknown>([["library", seeded]])
  const workspace = new Workspace(
    {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => values.set(key, value)
      }
    } as unknown as DurableObjectState,
    {
      ARTIFACTS: {
        put: async () => null,
        delete: async () => undefined
      }
    } as never
  )

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-a" }) }))
  await workspace.fetch(
    new Request("https://internal/library/upsert", {
      method: "POST",
      body: JSON.stringify({
        files: [{ signature: "hash-new", kind: "document", name: "newest.txt", mimeType: "text/plain", size: 10 }]
      })
    })
  )

  const library = values.get("library") as Array<{ id: string; signature: string }>
  assert.equal(library.length, MAX_LIBRARY_FILES, "the cap is enforced, not just exceeded")
  assert.ok(
    library.some((file) => file.signature === "hash-new"),
    "the newly uploaded file is kept"
  )
  assert.ok(!library.some((file) => file.id === oldestId), "the oldest file is evicted to make room")
})

test("legacy inline artifact payloads migrate to R2 before bootstrap returns metadata", async () => {
  const values = new Map<string, unknown>([
    [
      "library",
      [
        {
          id: "file-legacy",
          signature: "legacy-hash",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          attachment: {
            kind: "image",
            name: "legacy.png",
            mimeType: "image/png",
            size: 12,
            dataUrl: "data:image/png;base64,legacy-payload"
          }
        }
      ]
    ]
  ])
  const objects = new Map<string, string>()
  const workspace = new Workspace(
    {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => values.set(key, value)
      }
    } as unknown as DurableObjectState,
    {
      ARTIFACTS: {
        put: async (key: string, value: string) => {
          objects.set(key, value)
          return null
        },
        delete: async () => undefined
      }
    } as never
  )

  await workspace.fetch(new Request("https://internal/initialize", { method: "POST", body: JSON.stringify({ scope: "workspace-legacy" }) }))
  const bootstrap = await workspace.fetch(new Request("https://internal/bootstrap"))
  const data = (await bootstrap.json()) as { library: Array<Record<string, unknown>> }

  assert.equal(data.library.length, 1)
  assert.doesNotMatch(JSON.stringify(values.get("library")), /legacy-payload|data:image/)
  assert.equal(objects.size, 1)
  assert.match([...objects.values()][0] || "", /legacy-payload/)
})
