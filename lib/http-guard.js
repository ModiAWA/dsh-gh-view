/**
 * Same-origin and Host checks for the panel's named HTTP routes.
 *
 * The DSH web server dispatches a named route without a cookie, Host or Origin
 * check, so a plugin that exposes data must decide for itself which callers a
 * browser may speak for. These routes are read-only and any local process can
 * already run `gh` itself, so a plain local caller stays trusted; a browser is
 * held to its own origin, which closes the cross-site read path and the
 * DNS-rebinding path where a foreign hostname resolves to the loopback server.
 */
import { GhViewError } from './github.js'

/**
 * Reject a request a browser page must not be able to make.
 * @param {object} ctx plugin context, for this server's own origin
 * @param {import('node:http').IncomingMessage} request
 * @throws {GhViewError} with `GH_VIEW_BAD_ORIGIN` or `GH_VIEW_BAD_HOST`
 */
export function assertPanelRequestOrigin(ctx, request) {
  const headers = request?.headers ?? {}
  const host = String(headers.host ?? '').toLowerCase()
  const origin = headers.origin === undefined ? undefined : String(headers.origin)
  if (origin !== undefined) {
    // A same-origin browser request names the same host in both headers; any
    // other origin belongs to a page that must not read this data. Comparing the
    // two headers (rather than a stored origin string) also accepts `localhost`
    // and a configured LAN literal without treating either as cross-site. The
    // scheme must agree too: a cross-scheme origin is a different origin.
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      parsed = undefined
    }
    const protocol = ctx.webServer?.protocol === 'https:' ? 'https:' : 'http:'
    if (parsed === undefined || parsed.host.toLowerCase() !== host || parsed.protocol !== protocol) {
      throw new GhViewError('Refused a cross-origin request.', 'GH_VIEW_BAD_ORIGIN')
    }
  }
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    throw new GhViewError('Refused a cross-site request.', 'GH_VIEW_BAD_ORIGIN')
  }
  if (!allowedRequestHost(ctx, host)) {
    throw new GhViewError('Refused a request for another host.', 'GH_VIEW_BAD_HOST')
  }
}

/** Hosts this server may answer: its configured origin, or a loopback spelling. */
function allowedRequestHost(ctx, host) {
  // A raw local client may omit Host (HTTP/1.0, an Electron IPC bridge); browsers
  // always send one, so an absent Host cannot be the DNS-rebinding path.
  if (host === '') return true
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true
  try {
    const base = ctx.webServer?.getOrigin?.()
    if (typeof base === 'string') return new URL(base).host.toLowerCase() === host
  } catch {
    // No configured origin to compare against.
  }
  return false
}
