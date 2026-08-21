import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"
import {
  applyBrowserSecurityHeaders,
  CONTENT_SECURITY_POLICY
} from "../src/utils/browserSecurity"

function loadClientCore() {
  class TestNode {
    children: TestNode[] = []
    attributes = new Map<string, string>()
    dataset: Record<string, string> = {}
    textContent = ""
    type = ""
    className = ""

    constructor(readonly nodeName: string) {}

    appendChild(child: TestNode) {
      this.children.push(child)
      return child
    }

    setAttribute(name: string, value: string) {
      this.attributes.set(name, value)
    }
  }

  const document = {
    createDocumentFragment: () => new TestNode("#fragment"),
    createElement: (name: string) => new TestNode(name),
    createTextNode: (text: string) => {
      const node = new TestNode("#text")
      node.textContent = text
      return node
    }
  }
  const context = {
    window: {
      matchMedia: () => ({ matches: false })
    },
    document,
    crypto: { randomUUID: () => "test-id" },
    Headers,
    fetch
  }

  vm.runInNewContext(
    readFileSync(new URL("../pages/app-core.js", import.meta.url), "utf8"),
    context
  )

  return {
    core: context.window.LytaCore,
    TestNode
  }
}

test("streamed, saved, citation, and board text stays inert without a sanitizer global", () => {
  const { core, TestNode } = loadClientCore()
  const payload = '<img src=x onerror="globalThis.pwned=1">[Source 1]'

  for (const context of ["streamed", "saved-history", "citation", "board"]) {
    const fragment = core.renderMarkdown(
      payload,
      [{
        id: "chunk-1",
        label: "Source 1",
        fileId: "file-1",
        fileName: `<script>${context}</script>`,
        snippet: payload
      }]
    )

    const allNodes = (node: TestNode): TestNode[] =>
      [node, ...node.children.flatMap(allNodes)]
    const nodes = allNodes(fragment as TestNode)
    const text = nodes.map(node => node.textContent).join("")

    assert.match(text, /<img src=x onerror="globalThis\.pwned=1">/)
    assert.equal(nodes.filter(node => node.nodeName === "img" || node.nodeName === "script").length, 0)
    assert.equal(nodes.filter(node => node.nodeName === "button").length, 1)
    assert.equal(nodes.filter(node => node.nodeName === "button")[0]?.className, "citation-marker")
  }
})

test("Worker responses receive the deliberate browser security policy", () => {
  const secure = applyBrowserSecurityHeaders(
    new Response("ok", { headers: { "X-Existing": "preserved" } }),
    "https://lyta.example/chat"
  )

  assert.equal(secure.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY)
  assert.equal(secure.headers.get("X-Content-Type-Options"), "nosniff")
  assert.equal(secure.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
  assert.equal(secure.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains")
  assert.equal(secure.headers.get("X-Existing"), "preserved")

  const local = applyBrowserSecurityHeaders(new Response("ok"), "http://localhost:8787")
  assert.equal(local.headers.has("Strict-Transport-Security"), false)
})

test("the static asset policy is self-contained and matches the Worker policy", () => {
  const html = readFileSync(new URL("../pages/index.html", import.meta.url), "utf8")
  const headers = readFileSync(new URL("../pages/_headers", import.meta.url), "utf8")

  assert.match(html, /pdf\.min\.js" integrity="sha384-/)
  assert.match(html, /mammoth@1\.12\.1\/mammoth\.browser\.min\.js" integrity="sha384-/)
  assert.match(headers, /Content-Security-Policy: default-src 'self'.*cdnjs\.cloudflare\.com.*cdn\.jsdelivr\.net/)
  assert.match(headers, /X-Content-Type-Options: nosniff/)
  assert.match(headers, /Referrer-Policy: strict-origin-when-cross-origin/)
  assert.match(headers, /Permissions-Policy:/)
})
