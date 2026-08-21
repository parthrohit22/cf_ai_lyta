const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:"
].join("; ")

/** Apply browser protections to Worker-generated responses.
 * Static assets receive the matching policy from pages/_headers. */
export function applyBrowserSecurityHeaders(
  response: Response,
  requestUrl: string
): Response {
  const headers = new Headers(response.headers)

  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  )

  // HSTS is emitted only for HTTPS origins; browsers ignore it over HTTP.
  if (new URL(requestUrl).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export { CONTENT_SECURITY_POLICY }
