/**
 * Regressions from the pre-release code review.
 *
 * Each test pins one defect that a review found, so it cannot quietly come back:
 * a cache key that merged the two panel passes, a Jump that ignored the
 * reference's repository, a merged flag that lied, an image URL that 404'd, and
 * the hardening around the unauthenticated HTTP routes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { cardFor } from '../lib/render.js'
import { detectRemotes, listCacheKey } from '../lib/github.js'
import { assertPanelRequestOrigin } from '../lib/http-guard.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const execFileAsync = promisify(execFile)

test('list cache: the rows-only pass and the badge pass are separate entries', () => {
  const quick = listCacheKey('owner/repo', { kind: 'any', state: 'open', limit: 20, badges: false })
  const full = listCacheKey('owner/repo', { kind: 'any', state: 'open', limit: 20 })
  assert.notEqual(quick, full, 'a key without the badges flag makes the second panel pass a cached no-op')
  assert.ok(quick.includes(',0]|'), 'rows-only pass is marked in the tuple key')
  assert.ok(full.includes(',1]|'), 'badge pass is marked in the tuple key')
  // Identical calls still share one entry.
  assert.equal(full, listCacheKey('owner/repo', { kind: 'any', state: 'open', limit: 20 }))
})

test('list cache: credentials and source are part of the key', () => {
  const anonymous = listCacheKey('owner/repo', {}, {})
  const tokenA = listCacheKey('owner/repo', {}, { token: 'token-a' })
  const tokenB = listCacheKey('owner/repo', {}, { token: 'token-b' })
  const gh = listCacheKey('owner/repo', {}, { source: 'gh' })
  assert.notEqual(anonymous, tokenA)
  assert.notEqual(tokenA, tokenB)
  assert.notEqual(anonymous, gh)
  assert.ok(!tokenA.includes('token-a'), 'the token itself must not be kept in a cache key')
})

test('list cache: the ambient REST token is part of the identity', () => {
  const savedGitHub = process.env.GITHUB_TOKEN
  const savedGh = process.env.GH_TOKEN
  try {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'env-token-value'
    const withEnv = listCacheKey('owner/repo', {}, {})
    delete process.env.GITHUB_TOKEN
    const withoutEnv = listCacheKey('owner/repo', {}, {})
    const explicitAnonymous = listCacheKey('owner/repo', {}, { token: '' })
    assert.notEqual(withEnv, withoutEnv, 'the effective environment token changes the identity')
    assert.notEqual(withoutEnv, explicitAnonymous, '"use the environment token" is not "explicitly anonymous"')
  } finally {
    if (savedGitHub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGitHub
    if (savedGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGh
  }
})

test('remotes: a local-path remote is not mistaken for a GitHub repository', async (t) => {
  try {
    await execFileAsync('git', ['--version'])
  } catch {
    t.skip('git is not installed')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'ghv-remotes-local-'))
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir })
    // On POSIX this path would normalize to `srv/git` without the URL guard.
    await execFileAsync('git', ['remote', 'add', 'origin', '/srv/git/widgets.git'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'upstream', 'https://gitlab.com/group/project.git'], { cwd: dir })
    const remotes = await detectRemotes(dir)
    assert.equal(remotes.origin, null)
    assert.equal(remotes.upstream, null)
    assert.deepEqual(remotes.remotes, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('card: a numeric-looking payload field cannot inject markup', () => {
  const html = cardFor({
    kind: 'pr',
    number: '<b>9</b>',
    title: 't',
    state: 'open',
    author: { login: 'a', avatar: '' },
    labels: [],
    branch: { head: 'h', base: 'b' },
    additions: '<script>alert(1)</script>',
    deletions: '</span><img src=x onerror=alert(2)>',
    changedFiles: 1,
    commits: 1,
    comments: 0,
    checks: { state: 'none', success: 0, failure: 0, pending: 0, total: 0, failing: [] },
    approvals: [],
    changesRequested: [],
    body: '',
    createdAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/o/r/pull/1',
  })
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'))
  assert.ok(html.includes('#&lt;b&gt;9&lt;/b&gt;'), 'the item number is escaped too')
})

test('wiring: the panel view routes honor the repository inside owner/repo#123', () => {
  const host = read('index.js')
  const uses = host.match(/resolveRepo\(parsed\.repo\)/g) ?? []
  assert.ok(uses.length >= 2, 'both /view and /view-card must pass the reference repository')
  // The resolver must prefer that explicit repository over the selected one.
  assert.match(host, /const override = normalizeRepo\(explicit\)/)
})

test('wiring: the HTTP routes reject cross-origin and foreign-host requests', () => {
  const host = read('index.js')
  const guard = read('lib/http-guard.js')
  assert.ok(host.includes('assertPanelRequestOrigin(ctx, request)'), 'the route handler must run the guard')
  assert.ok(guard.includes('GH_VIEW_BAD_ORIGIN'))
  assert.ok(guard.includes('GH_VIEW_BAD_HOST'))
  assert.ok(guard.includes('sec-fetch-site'))
  assert.match(host, /code === 'GH_VIEW_BAD_ORIGIN' \|\| code === 'GH_VIEW_BAD_HOST'[\s\S]*?403/)
})

test('http guard: a browser is held to the server origin and host', () => {
  const ctx = { webServer: { getOrigin: () => 'http://127.0.0.1:6078', protocol: 'http:' } }
  const loopback = { headers: { host: '127.0.0.1:6078' } }
  assert.doesNotThrow(() => assertPanelRequestOrigin(ctx, loopback))
  assert.doesNotThrow(() => assertPanelRequestOrigin(ctx, {
    headers: { host: 'localhost:6078', origin: 'http://localhost:6078' },
  }))
  assert.throws(
    () => assertPanelRequestOrigin(ctx, { headers: { host: '127.0.0.1:6078', origin: 'https://evil.example' } }),
    (error) => error.code === 'GH_VIEW_BAD_ORIGIN',
  )
  assert.throws(
    () => assertPanelRequestOrigin(ctx, { headers: { host: '127.0.0.1:6078', origin: 'https://127.0.0.1:6078' } }),
    (error) => error.code === 'GH_VIEW_BAD_ORIGIN',
    'a cross-scheme origin is a different origin',
  )
  assert.throws(
    () => assertPanelRequestOrigin(ctx, { headers: { host: '127.0.0.1:6078', 'sec-fetch-site': 'cross-site' } }),
    (error) => error.code === 'GH_VIEW_BAD_ORIGIN',
  )
  assert.throws(
    () => assertPanelRequestOrigin(ctx, { headers: { host: 'evil.example' } }),
    (error) => error.code === 'GH_VIEW_BAD_HOST',
  )
  // A raw local client / IPC bridge may omit Host; browsers never do.
  assert.doesNotThrow(() => assertPanelRequestOrigin(ctx, { headers: {} }))
  // A configured non-loopback bind is legitimate for its own host name, not for others.
  const lan = { webServer: { getOrigin: () => 'http://192.168.1.5:6078', protocol: 'http:' } }
  assert.doesNotThrow(() => assertPanelRequestOrigin(lan, { headers: { host: '192.168.1.5:6078' } }))
  assert.throws(
    () => assertPanelRequestOrigin(lan, { headers: { host: 'evil.example' } }),
    (error) => error.code === 'GH_VIEW_BAD_HOST',
  )
})

test('http guard: the registered route handler runs it before dispatch', async () => {
  const { apply } = await import('../index.js')
  let handler
  const ctx = {
    tools: { register: () => () => {} },
    attachments: { saveImage: async () => ({}) },
    webServer: {
      register: (route) => { handler = route.handler; return () => {} },
      getOrigin: () => 'http://127.0.0.1:6078',
      protocol: 'http:',
    },
    workspaceRegistry: { list: () => [] },
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info: () => {} },
  }
  apply(ctx)
  assert.equal(typeof handler, 'function', 'apply must register the panel route')

  const makeResponse = () => ({
    writeHead(status) { this.status = status },
    end() {},
  })
  const ok = makeResponse()
  await handler({ url: '/gh-view/health', headers: { host: '127.0.0.1:6078' } }, ok)
  assert.equal(ok.status, 200)
  const blocked = makeResponse()
  await handler({ url: '/gh-view/health', headers: { host: 'evil.example' } }, blocked)
  assert.equal(blocked.status, 403)
})

test('wiring: dir confinement refuses UNC paths and re-checks the canonical path', () => {
  const host = read('index.js')
  assert.ok(host.includes('UNC or device path'), 'UNC/device paths must be refused before realpath')
  assert.match(host, /allowed\.has\(normalizeDirKey\(canonical\)\)/, 'a direct match must be re-checked after resolution')
  assert.ok(host.includes("process.platform === 'win32' && /^[\\\\/]{2}/"), 'the UNC shape check must be Windows-only')
  const refusals = host.match(/Directory lookups are limited to the registered workspaces\./g) ?? []
  assert.ok(refusals.length >= 3, 'a failed direct match must refuse instead of returning the unchecked spelling')
})

test('wiring: cursor walking is bounded by requests as well as rows', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes('MAX_PAGES'))
  assert.ok(data.includes('nodes.length === before'), 'a non-advancing page must end the walk')
  assert.ok(data.includes('seenCursors.has(next)'), 'a repeated cursor must end the walk')
  assert.ok(data.includes('if (seen.has(key)) continue'), 'a repeated row must not be returned twice')
})

test('wiring: PR list GraphQL respects an explicit API source', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes("(options.source ?? 'auto') !== 'api'"), 'a source: api caller must not be answered through gh')
})

test('wiring: the HTTP routes are refused on a non-loopback bind', () => {
  const host = read('index.js')
  assert.ok(host.includes('assertLoopbackBind(ctx)'), 'the route handler must check the bind address')
  assert.ok(host.includes('GH_VIEW_REMOTE_BIND'))
})

test('wiring: credentials are snapshotted once per data call', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes('options = resolveOptions(options)'))
  const snapshots = data.match(/options = resolveOptions\(options\)/g) ?? []
  assert.ok(snapshots.length >= 7, 'every cached read resolves its credential up front')
})

test('wiring: a GraphQL list row marks its checks as aggregate-only', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes('aggregate: true'))
  assert.ok(data.includes('do not fabricate a'))
  const client = read('client.js')
  assert.ok(client.includes('checks.aggregate'), 'the panel must not show an invented check count')
})

test('wiring: panel state has tokens for details and skips a redundant badge pass', () => {
  const client = read('client.js')
  assert.ok(client.includes('viewToken.current !== token'), 'a late detail answer must be dropped')
  assert.ok(client.includes('needsBadgePass'), 'PR rows already carry badges and need no second pass')
  assert.ok(client.includes('A line no block parser accepted must still consume input'), 'markdown parsing must always advance')
})

test('http guard: a LAN bind disables the routes', async () => {
  const { apply } = await import('../index.js')
  let handler
  const makeCtx = (getOrigin) => ({
    tools: { register: () => () => {} },
    attachments: { saveImage: async () => ({}) },
    webServer: {
      register: (route) => { handler = route.handler; return () => {} },
      getOrigin,
      protocol: 'http:',
    },
    workspaceRegistry: { list: () => [] },
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info: () => {} },
  })
  apply(makeCtx(() => 'http://192.168.1.5:6078'))
  const response = { writeHead(status) { this.status = status }, end() {} }
  await handler({ url: '/gh-view/health', headers: { host: '192.168.1.5:6078' } }, response)
  assert.equal(response.status, 403, 'a LAN-bound server must not expose credential-backed routes')
})

test('http guard: an unknown bind refuses the routes', async () => {
  const { apply } = await import('../index.js')
  let handler
  const makeCtx = (webServer) => ({
    tools: { register: () => () => {} },
    attachments: { saveImage: async () => ({}) },
    webServer: { register: (route) => { handler = route.handler; return () => {} }, ...webServer },
    workspaceRegistry: { list: () => [] },
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info: () => {} },
  })
  for (const webServer of [
    { protocol: 'http:' }, // getOrigin missing
    { getOrigin: () => { throw new Error('no URL form') }, protocol: 'http:' }, // throws
    { getOrigin: () => 'not a url', protocol: 'http:' }, // unparsable
  ]) {
    apply(makeCtx(webServer))
    const response = { writeHead(status) { this.status = status }, end() {} }
    await handler({ url: '/gh-view/health', headers: { host: '127.0.0.1:6078' } }, response)
    assert.equal(response.status, 403, 'a bind that cannot be confirmed must not be served')
  }
})

test('cache: a credential that appears mid-request is not adopted', async () => {
  const { getRepo, clearCache } = await import('../lib/github.js')
  const savedGitHub = process.env.GITHUB_TOKEN
  const savedGh = process.env.GH_TOKEN
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    globalThis.fetch = async (url, init = {}) => {
      calls.push(init.headers?.authorization ?? '')
      // The credential exists only after the call has begun.
      process.env.GITHUB_TOKEN = 'late-token'
      const target = String(url)
      const body = target.includes('/search/issues')
        ? JSON.stringify({ total_count: 0, items: [] })
        : target.includes('/releases')
          ? '[]'
          : JSON.stringify({ full_name: 'owner/repo', description: 'x', html_url: 'https://github.com/owner/repo', stargazers_count: 1, owner: { login: 'owner' } })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    clearCache()
    await getRepo('owner/repo', { source: 'api' })
    assert.ok(calls.length > 0)
    assert.ok(calls.every((auth) => auth === ''), 'the absent credential must stay absent for this operation')
    const before = calls.length
    delete process.env.GITHUB_TOKEN
    await getRepo('owner/repo', { source: 'api' })
    assert.equal(calls.length, before, 'the same anonymous identity reuses the cached result')
  } finally {
    globalThis.fetch = originalFetch
    if (savedGitHub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGitHub
    if (savedGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGh
  }
})

test('cache: a credential rotation during a request does not change its identity', async () => {
  const { getRepo, clearCache } = await import('../lib/github.js')
  const savedGitHub = process.env.GITHUB_TOKEN
  const savedGh = process.env.GH_TOKEN
  const originalFetch = globalThis.fetch
  const calls = []
  let rotated = false
  try {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'token-a'
    globalThis.fetch = async (url, init = {}) => {
      calls.push(init.headers?.authorization ?? '')
      if (!rotated) {
        rotated = true
        process.env.GITHUB_TOKEN = 'token-b'
      }
      const target = String(url)
      const body = target.includes('/search/issues')
        ? JSON.stringify({ total_count: 0, items: [] })
        : target.includes('/releases')
          ? '[]'
          : JSON.stringify({ full_name: 'owner/repo', description: 'x', html_url: 'https://github.com/owner/repo', stargazers_count: 1, owner: { login: 'owner' } })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    clearCache()
    await getRepo('owner/repo', { source: 'api' })
    assert.ok(calls.every((auth) => auth.includes('token-a')), 'the request identity was snapshotted before the fetch')
    const before = calls.length
    await getRepo('owner/repo', { source: 'api' })
    assert.ok(calls.length > before, 'the rotated credential is a different identity, so it refetches')
    assert.ok(calls.slice(before).every((auth) => auth.includes('token-b')))
  } finally {
    globalThis.fetch = originalFetch
    if (savedGitHub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGitHub
    if (savedGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGh
  }
})

test('cache: a credential rotation cannot share one cached result', async () => {
  const { getRepo, clearCache } = await import('../lib/github.js')
  const savedGitHub = process.env.GITHUB_TOKEN
  const savedGh = process.env.GH_TOKEN
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'token-a'
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), auth: init.headers?.authorization ?? '' })
      const target = String(url)
      const body = target.includes('/search/issues')
        ? JSON.stringify({ total_count: 0, items: [] })
        : target.endsWith('/releases')
          ? '[]'
          : JSON.stringify({
            full_name: 'owner/repo',
            description: 'x',
            html_url: 'https://github.com/owner/repo',
            stargazers_count: 1,
            owner: { login: 'owner' },
          })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    clearCache()
    await getRepo('owner/repo', { source: 'api' })
    assert.ok(calls.some((call) => call.auth.includes('token-a')), 'the ambient token is used')
    process.env.GITHUB_TOKEN = 'token-b'
    await getRepo('owner/repo', { source: 'api', token: '' })
    assert.ok(calls.some((call) => call.auth === ''), 'the explicit anonymous read performs its own request')
    assert.ok(calls.length > 4, 'the rotated identity must not be served from the first cache entry')
  } finally {
    globalThis.fetch = originalFetch
    if (savedGitHub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGitHub
    if (savedGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = savedGh
  }
})

test('wiring: PR detail keeps the API merged flag and covers legacy checks and log URLs', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes('merged = Boolean(pull.merged)'))
  assert.ok(!data.includes('Boolean(pull.merged) || pull.state'))
  assert.ok(data.includes('details_url: run.details_url'))
  assert.ok(data.includes('target_url: status.target_url'))
  assert.ok(data.includes('const [checkRuns, combined] = await Promise.all'), 'check runs and legacy statuses are read together')
  assert.ok(data.includes('...(combined?.statuses ?? [])'), 'legacy statuses merge into the rollup instead of being skipped')
})

test('wiring: closed pull-request lists include merged PRs and page past 100', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes("['CLOSED', 'MERGED']"), 'a merged PR is not CLOSED in GitHub state')
  assert.ok(data.includes('pageInfo { hasNextPage endCursor }'))
  assert.ok(data.includes('Math.min(100, wanted - nodes.length)'))
})

test('wiring: a broken gh CLI falls back to the REST source', () => {
  const data = read('lib/github.js')
  assert.ok(data.includes("if (source !== 'auto') throw failure"), 'auto falls back for any gh failure')
  assert.match(data, /apiFetch\(path, suffix, \{ token \}\)/)
})

test('wiring: repository-relative images resolve through the default branch', () => {
  const client = read('client.js')
  assert.ok(client.includes('raw.githubusercontent.com/${owner}/HEAD/'))
  assert.ok(client.includes('listToken.current !== token'), 'a late list answer must be dropped')
  assert.ok(client.includes('repoText: repo,'), 'the repository field must show what the user types')
  assert.ok(client.includes('state.view.repo'), 'refresh must re-open the item\'s own repository')
  assert.ok(client.includes("Object.hasOwn(body, 'data')"), 'a null data answer must survive the call helper')
  assert.ok(client.includes('match[23]') && client.includes('match[24]'), 'raw HTML anchor text is rendered from the right groups')
  assert.ok(client.includes('filter: filterOverride'), 'filters go through the guarded loader')
  assert.ok(client.includes('item.repository ?') , 'a row opens its own repository')
  assert.ok(read('lib/render.js').includes("list.state === 'closed'"), 'a closed/all list card is not titled Open')
})

test('wiring: rendering is capped and built file URLs are escaped', () => {
  const renderer = read('lib/render.js')
  assert.ok(renderer.includes('MAX_CONCURRENT_RENDERS'))
  assert.ok(renderer.includes('MAX_QUEUED_RENDERS'), 'the render queue is bounded too')
  assert.ok(renderer.includes('esc(pull.additions)'))
  assert.ok(renderer.includes('esc(pull.deletions)'))
  assert.ok(renderer.includes('pathToFileURL(htmlPath).href'))
  assert.ok(renderer.includes('data:image'), 'only http(s) or inline images may become card sources')
})

test('sources: no GBK-mangled punctuation survives in shipped text', () => {
  // These code points are what UTF-8 punctuation turns into after a round trip
  // through a GBK console; none of them belongs in this English-source tree.
  const mangled = /[\u9225\u923d\u6a9a\u8def\ufffd]/
  const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (/\.(js|mjs|json|md|yml|svg)$/.test(entry.name)) out.push(full)
    }
    return out
  }
  for (const file of walk(root)) {
    const rel = file.slice(root.length).replace(/^[\\/]/, '')
    if (rel.startsWith('locale/')) continue // Chinese locale text is legitimate
    assert.doesNotMatch(readFileSync(file, 'utf8'), mangled, `${rel} contains mojibake`)
  }
})
