import { createId } from "../auth/crypto"
import type { Env } from "../index"
import { buildLibrarySearchResult, type WorkspaceChunk } from "../library/chunks"
import {
  CONTEXT_SELECTION_POLICY_VERSION,
  normalizeContextKind,
  uniqueIds,
  type ContextProvenance,
  type ContextSelectionManifest,
  type ProjectContextRecord
} from "../context/projectContext"

interface WorkspaceProfile {
  name: string
  workspace: string
  email: string
}

interface WorkspacePreferences {
  theme: Record<string, string>
  ui: {
    sidebarHidden: boolean
    boardOpen: boolean
    chatMode: string
  }
}

interface WorkspaceSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface StoredLibraryFile {
  id: string
  signature: string
  contentHash: string
  workspaceScope: string
  objectKey: string
  ingestionState: "ready"
  createdAt: string
  updatedAt: string
  sourceVersionId: string
  retention: "until-user-delete"
  attachment: {
    id?: string
    kind: "image" | "document"
    name: string
    mimeType: string
    size: number
    summary?: string
  }
}

type IncomingLibraryAttachment = StoredLibraryFile["attachment"] & {
  signature?: string
  dataUrl?: string
  extractedText?: string
}

type LegacyStoredLibraryFile = Partial<StoredLibraryFile> & {
  id: string
  signature: string
  attachment: StoredLibraryFile["attachment"] & {
    dataUrl?: string
    extractedText?: string
  }
}

const MAX_SESSIONS = 80
const MAX_LIBRARY_FILES = 40
const MAX_LIBRARY_CHUNKS = 300
const MAX_ARTIFACT_BYTES = 2_400_000
const MAX_WORKSPACE_ARTIFACT_BYTES = 12_000_000
const LIBRARY_PAGE_SIZE = 20

export class Workspace {
  state: DurableObjectState
  env: Env
  private lock: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname

    if (path === "/initialize" && request.method === "POST") {
      return this.queue(() => this.initialize(request))
    }

    if (path === "/bootstrap" && request.method === "GET") {
      return this.bootstrap()
    }

    if (path === "/profile" && request.method === "POST") {
      return this.queue(() => this.updateProfile(request))
    }

    if (path === "/preferences" && request.method === "POST") {
      return this.queue(() => this.updatePreferences(request))
    }

    if (path === "/sessions" && request.method === "GET") {
      return this.getSessions()
    }

    if (path === "/sessions/create" && request.method === "POST") {
      return this.queue(() => this.createSession())
    }

    if (path === "/sessions/rename" && request.method === "POST") {
      return this.queue(() => this.renameSession(request))
    }

    if (path === "/sessions/delete" && request.method === "POST") {
      return this.queue(() => this.deleteSession(request))
    }

    if (path === "/sessions/touch" && request.method === "POST") {
      return this.queue(() => this.touchSession(request))
    }

    if (path === "/sessions/has" && request.method === "POST") {
      return this.hasSession(request)
    }

    if (path === "/library" && request.method === "GET") {
      return this.getLibrary(request)
    }

    if (path === "/library/upsert" && request.method === "POST") {
      return this.queue(() => this.upsertLibrary(request))
    }

    if (path === "/library/quota" && request.method === "POST") {
      return this.checkLibraryQuota(request)
    }

    if (path === "/library/delete" && request.method === "POST") {
      return this.queue(() => this.deleteLibraryFile(request))
    }

    if (path === "/library/search" && request.method === "POST") {
      return this.queue(() => this.searchLibrary(request))
    }

    if (path === "/context" && request.method === "GET") {
      return this.getContext(request)
    }

    if (path === "/context/records" && request.method === "POST") {
      return this.queue(() => this.upsertContextRecord(request))
    }

    if (path === "/context/records/delete" && request.method === "POST") {
      return this.queue(() => this.deleteContextRecord(request))
    }

    if (path === "/context/manifests" && request.method === "GET") {
      return this.getContextManifests(request)
    }

    return new Response("Not Found", { status: 404 })
  }

  private async queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn)
    this.lock = next.then(
      () => {},
      () => {}
    )
    return next
  }

  private async initialize(request: Request) {
    const body = (await request.json()) as {
      name?: string
      workspace?: string
      email?: string
      scope?: string
    }

    const profile = (await this.state.storage.get<WorkspaceProfile>("profile")) || null

    if (profile) {
      if (body.scope && !(await this.state.storage.get("workspaceScope"))) {
        await this.state.storage.put("workspaceScope", normalizeText(body.scope, 120) || "legacy")
      }
      return Response.json({ ok: true })
    }

    await this.state.storage.put("profile", {
      name: normalizeText(body.name, 40) || "Guest User",
      workspace: normalizeText(body.workspace, 50) || "Private Workspace",
      email: normalizeText(body.email, 120)
    } satisfies WorkspaceProfile)

    await this.state.storage.put("workspaceScope", normalizeText(body.scope, 120) || "legacy")

    await this.state.storage.put("preferences", {
      theme: {},
      ui: {
        sidebarHidden: false,
        boardOpen: true,
        chatMode: "instant"
      }
    } satisfies WorkspacePreferences)

    return Response.json({ ok: true })
  }

  private async bootstrap() {
    const profile = (await this.state.storage.get<WorkspaceProfile>("profile")) || {
      name: "Guest User",
      workspace: "Private Workspace",
      email: ""
    }

    const preferences = normalizePreferences((await this.state.storage.get<WorkspacePreferences>("preferences")) || null)

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const library = await this.loadLibrary()

    return Response.json({
      profile,
      preferences,
      sessions,
      library: library.slice(0, LIBRARY_PAGE_SIZE).map(toLibraryClientFile),
      libraryPage: {
        nextCursor: library.length > LIBRARY_PAGE_SIZE ? String(LIBRARY_PAGE_SIZE) : null
      }
    })
  }

  private async updateProfile(request: Request) {
    const body = (await request.json()) as {
      name?: string
      workspace?: string
    }

    const current = (await this.state.storage.get<WorkspaceProfile>("profile")) || {
      name: "Guest User",
      workspace: "Private Workspace",
      email: ""
    }

    const next = {
      ...current,
      name: normalizeText(body.name, 40) || current.name,
      workspace: normalizeText(body.workspace, 50) || current.workspace
    }

    await this.state.storage.put("profile", next)

    return Response.json({
      profile: next
    })
  }

  private async updatePreferences(request: Request) {
    const body = (await request.json()) as {
      theme?: Record<string, string>
      ui?: {
        sidebarHidden?: boolean
        boardOpen?: boolean
        chatMode?: string
      }
    }

    const current = normalizePreferences((await this.state.storage.get<WorkspacePreferences>("preferences")) || null)

    const next = {
      theme: sanitizeTheme(body.theme ?? current.theme),
      ui: {
        sidebarHidden: Boolean(body.ui?.sidebarHidden ?? current.ui.sidebarHidden),
        boardOpen: Boolean(body.ui?.boardOpen ?? current.ui.boardOpen),
        chatMode: body.ui?.chatMode === "deep" || body.ui?.chatMode === "creative" ? body.ui.chatMode : current.ui.chatMode || "instant"
      }
    } satisfies WorkspacePreferences

    await this.state.storage.put("preferences", next)

    return Response.json({
      preferences: next
    })
  }

  private async getSessions() {
    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    return Response.json({ sessions })
  }

  private async createSession() {
    let sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const now = new Date().toISOString()
    const id = createId("chat")

    sessions.unshift({
      id,
      title: "New Chat",
      createdAt: now,
      updatedAt: now
    })

    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(0, MAX_SESSIONS)
    }

    await this.state.storage.put("sessions", sortSessions(sessions))

    return Response.json({
      session: sortSessions(sessions)[0]
    })
  }

  private async renameSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
      title?: string
    }

    if (!body?.id || !body?.title) {
      return new Response("Invalid rename", { status: 400 })
    }

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const session = sessions.find((item) => item.id === body.id)

    if (session) {
      session.title = normalizeText(body.title, 60) || session.title
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async deleteSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions = (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    await this.state.storage.put("sessions", sortSessions(sessions.filter((session) => session.id !== body.id)))

    return Response.json({ ok: true })
  }

  private async touchSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid session", { status: 400 })
    }

    const sessions = sortSessions((await this.state.storage.get<WorkspaceSession[]>("sessions")) || [])

    const session = sessions.find((item) => item.id === body.id)

    if (session) {
      session.updatedAt = new Date().toISOString()
      await this.state.storage.put("sessions", sortSessions(sessions))
    }

    return Response.json({ ok: true })
  }

  private async hasSession(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    const sessions = (await this.state.storage.get<WorkspaceSession[]>("sessions")) || []

    return Response.json({
      exists: !!body?.id && sessions.some((session) => session.id === body.id)
    })
  }

  private async getLibrary(request: Request) {
    const files = await this.loadLibrary()
    const url = new URL(request.url)
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0)
    const limit = Math.min(
      LIBRARY_PAGE_SIZE,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || String(LIBRARY_PAGE_SIZE), 10) || LIBRARY_PAGE_SIZE)
    )
    const page = files.slice(offset, offset + limit)

    return Response.json({
      files: page.map(toLibraryClientFile),
      nextCursor: offset + page.length < files.length ? String(offset + page.length) : null
    })
  }

  private async checkLibraryQuota(request: Request) {
    const body = (await request.json()) as { files?: Array<{ size?: number }> }
    const incoming = Array.isArray(body.files) ? body.files : []
    const incomingBytes = incoming.reduce((total, file) => total + (Number.isFinite(file?.size) ? Math.max(0, Number(file.size)) : 0), 0)
    const library = await this.loadLibrary()
    const usedBytes = library.reduce((total, file) => total + file.attachment.size, 0)

    if (incoming.some((file) => Number(file?.size) > MAX_ARTIFACT_BYTES) || usedBytes + incomingBytes > MAX_WORKSPACE_ARTIFACT_BYTES) {
      return new Response("Workspace artifact quota exceeded", { status: 413 })
    }

    return Response.json({ ok: true, remainingBytes: MAX_WORKSPACE_ARTIFACT_BYTES - usedBytes - incomingBytes })
  }

  private async upsertLibrary(request: Request) {
    const body = (await request.json()) as {
      files?: IncomingLibraryAttachment[]
      chunks?: WorkspaceChunk[]
    }

    const incomingFiles = Array.isArray(body.files) ? body.files : []
    const incomingChunks = Array.isArray(body.chunks) ? body.chunks : []

    let library = await this.loadLibrary()
    let chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const now = new Date().toISOString()
    const storedFiles: StoredLibraryFile[] = []

    for (const incoming of incomingFiles) {
      const signature = normalizeText(incoming.signature, 200)

      if (!signature) {
        continue
      }

      const existing = library.find((file) => file.signature === signature)

      if (existing) {
        existing.updatedAt = now
        storedFiles.push(existing)
        continue
      }

      const id = createId("file")
      const objectKey = `workspaces/${await this.workspaceScope()}/artifacts/${id}/${signature}`
      await this.env.ARTIFACTS.put(
        objectKey,
        JSON.stringify({
          dataUrl: incoming.kind === "image" ? incoming.dataUrl || "" : undefined,
          extractedText: incoming.kind === "document" ? incoming.extractedText || "" : undefined
        }),
        { httpMetadata: { contentType: "application/json" } }
      )

      const next: StoredLibraryFile = {
        id,
        signature,
        contentHash: signature,
        workspaceScope: await this.workspaceScope(),
        objectKey,
        ingestionState: "ready",
        createdAt: now,
        updatedAt: now,
        sourceVersionId: `source-version:${signature}`,
        retention: "until-user-delete",
        attachment: {
          id: incoming.id,
          kind: incoming.kind,
          name: normalizeText(incoming.name, 120) || "Attachment",
          mimeType: normalizeText(incoming.mimeType, 120) || "application/octet-stream",
          size: Number.isFinite(incoming.size) ? incoming.size : 0,
          summary: normalizeText(incoming.summary, 280)
        }
      }

      library.unshift(next)
      storedFiles.push(next)
    }

    for (const storedFile of storedFiles) {
      chunks = chunks.filter((chunk) => chunk.fileId !== storedFile.id)

      const matchingChunks = incomingChunks
        .filter((chunk) => chunk.fileId === storedFile.signature)
        .map((chunk, index) => ({
          // The import pipeline derives this from the immutable source hash and
          // index. Preserve it rather than replacing it with a random DO id.
          id: normalizeText(chunk.id, 240) || `${storedFile.sourceVersionId}:chunk:${index}`,
          fileId: storedFile.id,
          fileName: storedFile.attachment.name,
          text: chunk.text,
          vector: chunk.vector,
          sourceVersionId: storedFile.sourceVersionId,
          createdAt: now
        }))

      chunks.push(...matchingChunks)
    }

    if (library.length > MAX_LIBRARY_FILES) {
      const removed = library.slice(MAX_LIBRARY_FILES)
      const removedIds = new Set(removed.map((file) => file.id))
      library = library.slice(0, MAX_LIBRARY_FILES)
      chunks = chunks.filter((chunk) => !removedIds.has(chunk.fileId))
    }

    if (chunks.length > MAX_LIBRARY_CHUNKS) {
      chunks = chunks.slice(-MAX_LIBRARY_CHUNKS)
    }

    await this.state.storage.put("library", library)
    await this.state.storage.put("libraryChunks", chunks)

    return Response.json({
      files: storedFiles.map(toLibraryClientFile)
    })
  }

  private async deleteLibraryFile(request: Request) {
    const body = (await request.json()) as {
      id?: string
    }

    if (!body?.id) {
      return new Response("Invalid file", { status: 400 })
    }

    const library = await this.loadLibrary()
    const chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const deleted = library.find((file) => file.id === body.id)

    if (deleted) {
      await this.env.ARTIFACTS.delete(deleted.objectKey)
    }

    const deletionImpact = await this.removeContextReferences({
      sourceFileIds: [body.id],
      sourceVersionIds: deleted ? [deleted.sourceVersionId] : [],
      chunkIds: chunks.filter((chunk) => chunk.fileId === body.id).map((chunk) => chunk.id)
    })

    await this.state.storage.put(
      "library",
      library.filter((file) => file.id !== body.id)
    )

    await this.state.storage.put(
      "libraryChunks",
      chunks.filter((chunk) => chunk.fileId !== body.id)
    )

    return Response.json({ ok: true, deletionImpact })
  }

  private async workspaceScope() {
    return (await this.state.storage.get<string>("workspaceScope")) || "legacy"
  }

  /**
   * One-way lazy migration for v3 inline attachment records. The old Durable
   * Object value is rewritten only after every corresponding R2 write succeeds.
   */
  private async loadLibrary(): Promise<StoredLibraryFile[]> {
    const stored = (await this.state.storage.get<LegacyStoredLibraryFile[]>("library")) || []

    if (!stored.some((file) => !file.ingestionState || !file.objectKey || !file.contentHash || !file.sourceVersionId || !file.retention)) {
      return stored as StoredLibraryFile[]
    }

    const scope = await this.workspaceScope()
    const migrated: StoredLibraryFile[] = []

    for (const file of stored) {
      if (file.ingestionState && file.objectKey && file.contentHash) {
        migrated.push({
          ...(file as StoredLibraryFile),
          sourceVersionId: file.sourceVersionId || `source-version:${file.signature || file.id}`,
          retention: "until-user-delete"
        })
        continue
      }

      const id = file.id || createId("file")
      const signature = file.signature || id
      const objectKey = `workspaces/${scope}/artifacts/${id}/${signature}`
      const attachment = file.attachment || {
        kind: "document" as const,
        name: "Attachment",
        mimeType: "application/octet-stream",
        size: 0
      }

      await this.env.ARTIFACTS.put(
        objectKey,
        JSON.stringify({
          dataUrl: attachment.dataUrl || undefined,
          extractedText: attachment.extractedText || undefined
        }),
        { httpMetadata: { contentType: "application/json" } }
      )

      const { dataUrl: _dataUrl, extractedText: _extractedText, ...metadata } = attachment
      migrated.push({
        id,
        signature,
        contentHash: signature,
        workspaceScope: scope,
        objectKey,
        ingestionState: "ready",
        createdAt: file.createdAt || new Date().toISOString(),
        updatedAt: file.updatedAt || new Date().toISOString(),
        sourceVersionId: `source-version:${signature}`,
        retention: "until-user-delete",
        attachment: metadata
      })
    }

    await this.state.storage.put("library", migrated)
    return migrated
  }

  private async searchLibrary(request: Request) {
    const body = (await request.json()) as {
      queryVector?: number[]
      topK?: number
      requestId?: string
      policyVersion?: string
    }

    const queryVector = Array.isArray(body.queryVector) ? body.queryVector.filter((value) => typeof value === "number") : []

    if (!queryVector.length) {
      return Response.json({
        context: "",
        citations: []
      })
    }

    const chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []

    const result = buildLibrarySearchResult(queryVector, chunks, typeof body.topK === "number" ? body.topK : 4)

    await this.recordContextManifest({
      requestId: normalizeText(body.requestId, 120) || createId("context-request"),
      policyVersion: normalizeText(body.policyVersion, 80) || CONTEXT_SELECTION_POLICY_VERSION,
      citations: result.citations
    })

    return Response.json(result)
  }

  private async getContext(request: Request) {
    const url = new URL(request.url)
    const includeContent = url.searchParams.get("includeContent") === "true"
    const records = await this.loadContextRecords()
    const library = await this.loadLibrary()

    return Response.json({
      sources: library.map(toContextSource),
      records: records.map((record) => (includeContent ? record : toContextRecordMetadata(record)))
    })
  }

  private async getContextManifests(request: Request) {
    const url = new URL(request.url)
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 30, 100))
    const manifests = await this.loadContextManifests()
    return Response.json({ manifests: manifests.slice(0, limit) })
  }

  private async upsertContextRecord(request: Request) {
    const body = (await request.json()) as Partial<ProjectContextRecord> & {
      provenance?: Partial<ContextProvenance>
    }
    const kind = normalizeContextKind(body.kind)
    const title = normalizeText(body.title, 160)
    const content = normalizeTextBlock(body.content, 12_000)

    if (!kind || !title || !content) {
      return new Response("A context kind, title, and content are required", { status: 400 })
    }

    const scope = await this.workspaceScope()
    const records = await this.loadContextRecords()
    const library = await this.loadLibrary()
    const chunks = (await this.state.storage.get<WorkspaceChunk[]>("libraryChunks")) || []
    const fileIds = new Set(library.map((file) => file.id))
    const sourceVersionIds = new Set(library.map((file) => file.sourceVersionId))
    const chunkIds = new Set(chunks.map((chunk) => chunk.id))
    const now = new Date().toISOString()
    const existing = records.find((record) => record.id === normalizeText(body.id, 180))
    const record: ProjectContextRecord = {
      id: existing?.id || createId(`context-${kind}`),
      kind,
      title,
      content,
      workspaceScope: scope,
      provenance: {
        createdBy: "user",
        sourceFileIds: uniqueIds(body.provenance?.sourceFileIds).filter((id) => fileIds.has(id)),
        sourceVersionIds: uniqueIds(body.provenance?.sourceVersionIds).filter((id) => sourceVersionIds.has(id)),
        chunkIds: uniqueIds(body.provenance?.chunkIds).filter((id) => chunkIds.has(id))
      },
      approval: kind === "summary" ? "user-approved" : "not-required",
      retention: "until-user-delete",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    await this.state.storage.put(
      "projectContextRecords",
      [record, ...records.filter((candidate) => candidate.id !== record.id)].slice(0, 200)
    )
    return Response.json({ record: toContextRecordMetadata(record) })
  }

  private async deleteContextRecord(request: Request) {
    const body = (await request.json()) as { id?: string }
    const id = normalizeText(body.id, 180)
    if (!id) return new Response("Invalid context record", { status: 400 })

    const records = await this.loadContextRecords()
    const exists = records.some((record) => record.id === id)
    await this.state.storage.put(
      "projectContextRecords",
      records.filter((record) => record.id !== id)
    )
    return Response.json({ ok: true, deleted: exists })
  }

  private async removeContextReferences(provenance: Partial<ContextProvenance>) {
    const sourceFileIds = new Set(provenance.sourceFileIds || [])
    const sourceVersionIds = new Set(provenance.sourceVersionIds || [])
    const chunkIds = new Set(provenance.chunkIds || [])
    const records = await this.loadContextRecords()
    const affectedRecords = records.filter(
      (record) =>
        record.provenance.sourceFileIds.some((id) => sourceFileIds.has(id)) ||
        record.provenance.sourceVersionIds.some((id) => sourceVersionIds.has(id)) ||
        record.provenance.chunkIds.some((id) => chunkIds.has(id))
    )

    // Deleting a source invalidates derived records. This avoids surfacing a
    // finding or decision whose supporting evidence is no longer available.
    await this.state.storage.put(
      "projectContextRecords",
      records.filter((record) => !affectedRecords.includes(record))
    )
    // Manifests are immutable audit evidence. They contain IDs only, so keeping
    // them records what a previous request received without retaining content.
    return { removedDerivedRecords: affectedRecords.length }
  }

  private async recordContextManifest(input: {
    requestId: string
    policyVersion: string
    citations: Array<{ id: string; fileId: string }>
  }) {
    const library = await this.loadLibrary()
    const sourceFileIds = uniqueIds(input.citations.map((citation) => citation.fileId))
    const sourceVersionIds = sourceFileIds
      .map((fileId) => library.find((file) => file.id === fileId)?.sourceVersionId)
      .filter((value): value is string => Boolean(value))
    const manifest: ContextSelectionManifest = {
      id: createId("context-manifest"),
      workspaceScope: await this.workspaceScope(),
      requestId: input.requestId,
      policyVersion: input.policyVersion,
      selectedSourceFileIds: sourceFileIds,
      selectedSourceVersionIds: uniqueIds(sourceVersionIds),
      selectedChunkIds: uniqueIds(input.citations.map((citation) => citation.id)),
      selectedContextRecordIds: [],
      createdAt: new Date().toISOString()
    }
    const manifests = await this.loadContextManifests()
    manifests.unshift(manifest)
    await this.state.storage.put("contextSelectionManifests", manifests.slice(0, 200))
  }

  private async loadContextRecords() {
    return (await this.state.storage.get<ProjectContextRecord[]>("projectContextRecords")) || []
  }

  private async loadContextManifests() {
    return (await this.state.storage.get<ContextSelectionManifest[]>("contextSelectionManifests")) || []
  }
}

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function normalizeTextBlock(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function sanitizeTheme(theme: Record<string, string>) {
  const next: Record<string, string> = {}

  for (const [key, value] of Object.entries(theme)) {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      next[key] = value.toLowerCase()
    }
  }

  return next
}

function toLibraryClientFile(file: StoredLibraryFile) {
  return {
    libraryFileId: file.id,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    ...file.attachment
  }
}

function toContextSource(file: StoredLibraryFile) {
  const { id: _attachmentId, ...attachment } = file.attachment
  return {
    id: file.id,
    sourceVersionId: file.sourceVersionId,
    workspaceScope: file.workspaceScope,
    retention: file.retention,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    ...attachment
  }
}

function toContextRecordMetadata(record: ProjectContextRecord) {
  const { content: _content, ...metadata } = record
  return metadata
}

function sortSessions(sessions: WorkspaceSession[]) {
  return [...sessions].sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function normalizePreferences(preferences: WorkspacePreferences | null): WorkspacePreferences {
  return {
    theme: sanitizeTheme(preferences?.theme || {}),
    ui: {
      sidebarHidden: Boolean(preferences?.ui?.sidebarHidden),
      boardOpen: preferences?.ui?.boardOpen !== false,
      chatMode: preferences?.ui?.chatMode === "deep" || preferences?.ui?.chatMode === "creative" ? preferences.ui.chatMode : "instant"
    }
  }
}
