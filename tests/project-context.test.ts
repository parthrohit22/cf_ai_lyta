import assert from "node:assert/strict"
import { test } from "node:test"
import { Workspace } from "../src/durable/workspace"

function createWorkspace(scope: string) {
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

  return {
    values,
    workspace,
    initialize: () => workspace.fetch(new Request("https://internal/initialize", {
      method: "POST", body: JSON.stringify({ scope })
    }))
  }
}

async function importSource(workspace: Workspace, signature: string, text: string) {
  const response = await workspace.fetch(new Request("https://internal/library/upsert", {
    method: "POST",
    body: JSON.stringify({
      files: [{ signature, kind: "document", name: "architecture.txt", mimeType: "text/plain", size: text.length, extractedText: text }],
      chunks: [{ id: `${signature}-0`, fileId: signature, fileName: "architecture.txt", text, vector: [1, 0] }]
    })
  }))
  return response.json() as Promise<{ files: Array<{ libraryFileId: string }> }>
}

test("canonical context preserves source versions and records non-sensitive selection manifests", async () => {
  const fixture = createWorkspace("workspace-context-a")
  await fixture.initialize()
  const imported = await importSource(fixture.workspace, "immutable-hash-a", "private architecture evidence")
  const source = (await fixture.workspace.fetch(new Request("https://internal/context"))).json() as Promise<{
    sources: Array<{ id: string; sourceVersionId: string; workspaceScope: string; retention: string }>
  }>
  const sourceData = await source
  assert.equal(sourceData.sources[0]?.id, imported.files[0].libraryFileId)
  assert.equal(sourceData.sources[0]?.sourceVersionId, "source-version:immutable-hash-a")
  assert.equal(sourceData.sources[0]?.workspaceScope, "workspace-context-a")
  assert.equal(sourceData.sources[0]?.retention, "until-user-delete")

  await fixture.workspace.fetch(new Request("https://internal/library/search", {
    method: "POST",
    body: JSON.stringify({ queryVector: [1, 0], requestId: "request-context-a" })
  }))
  const manifests = await (await fixture.workspace.fetch(new Request("https://internal/context/manifests"))).json() as {
    manifests: Array<Record<string, unknown>>
  }
  assert.equal(manifests.manifests.length, 1)
  assert.deepEqual(manifests.manifests[0].selectedChunkIds, ["immutable-hash-a-0"])
  assert.match(String(manifests.manifests[0].policyVersion), /^2026-/)
  assert.doesNotMatch(JSON.stringify(manifests), /private architecture evidence/)
})

test("deleting a source removes dependent context records while retaining ID-only audit history", async () => {
  const fixture = createWorkspace("workspace-context-delete")
  await fixture.initialize()
  const imported = await importSource(fixture.workspace, "immutable-hash-delete", "confidential source")
  const fileId = imported.files[0].libraryFileId

  const created = await (await fixture.workspace.fetch(new Request("https://internal/context/records", {
    method: "POST",
    body: JSON.stringify({
      kind: "summary",
      title: "Approved summary",
      content: "A concise user-approved summary.",
      provenance: { sourceFileIds: [fileId], sourceVersionIds: ["source-version:immutable-hash-delete"], chunkIds: ["immutable-hash-delete-0"] }
    })
  }))).json() as { record: { approval: string; id: string } }
  assert.equal(created.record.approval, "user-approved")

  await fixture.workspace.fetch(new Request("https://internal/library/search", {
    method: "POST", body: JSON.stringify({ queryVector: [1, 0], requestId: "request-delete" })
  }))
  const deleted = await (await fixture.workspace.fetch(new Request("https://internal/library/delete", {
    method: "POST", body: JSON.stringify({ id: fileId })
  }))).json() as { deletionImpact: { removedDerivedRecords: number } }
  assert.equal(deleted.deletionImpact.removedDerivedRecords, 1)

  const context = await (await fixture.workspace.fetch(new Request("https://internal/context?includeContent=true"))).json() as {
    sources: unknown[]; records: unknown[]
  }
  assert.equal(context.sources.length, 0)
  assert.equal(context.records.length, 0)
  const manifests = await (await fixture.workspace.fetch(new Request("https://internal/context/manifests"))).json() as { manifests: unknown[] }
  assert.equal(manifests.manifests.length, 1)
})

test("workspace context and manifests are isolated", async () => {
  const left = createWorkspace("workspace-left")
  const right = createWorkspace("workspace-right")
  await Promise.all([left.initialize(), right.initialize()])
  await importSource(left.workspace, "left-hash", "left private source")
  await left.workspace.fetch(new Request("https://internal/library/search", {
    method: "POST", body: JSON.stringify({ queryVector: [1, 0], requestId: "left-request" })
  }))

  const rightContext = await (await right.workspace.fetch(new Request("https://internal/context?includeContent=true"))).json() as {
    sources: unknown[]; records: unknown[]
  }
  const rightManifests = await (await right.workspace.fetch(new Request("https://internal/context/manifests"))).json() as { manifests: unknown[] }
  assert.deepEqual(rightContext.sources, [])
  assert.deepEqual(rightContext.records, [])
  assert.deepEqual(rightManifests.manifests, [])
})
