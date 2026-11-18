/**
 * GitHub data access for gh-view.
 *
 * Two interchangeable sources, in the order the user asked for:
 *   1. the `gh` CLI (uses its existing login, so private repos work without
 *      this plugin ever seeing a token),
 *   2. the public REST API (anonymous, or GITHUB_TOKEN / GH_TOKEN if present).
 *
 * Every caller gets the same normalized shapes below, so the renderer and the
 * agent tools never branch on which source answered.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Marker in every error message so the tool layer can classify failures. */
export class GhViewError extends Error {
  constructor(message, code = 'GH_VIEW_ERROR') {
    super(message)
    this.name = 'GhViewError'
    this.code = code
  }
}

/** Run one executable and resolve its stdout, with a hard timeout. */
function run(command, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim().split('\n')[0]
          reject(Object.assign(error, { detail }))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/** `owner/repo` or a bare `repo` resolved later. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * Reject a segment that could be read as a flag or a file reference.
 *
 * Two hazards, and only two:
 *
 * - A leading `-` makes an argument look like an option.
 * - `gh -F name=@path` reads `path` and sends its contents as the value, so a
 *   "repository name" beginning with `@` would exfiltrate a local file.
 *
 * `..` is rejected because it is the traversal form that retargets
 * `/repos/../user` at another API endpoint.
 *
 * A bare leading dot is NOT rejected: `.github` is one of the most common
 * repository names on GitHub (it holds org-level issue and PR templates), so
 * `owner/.github` has to keep working. Only `..` is dangerous, not `.x`.
 */
function assertSafeSegment(segment, input) {
  const unsafe =
    !REPO_PATTERN.test(segment)
    || segment.startsWith('-')
    || segment.startsWith('@')
    || segment === '..'
    || segment === '.'
  if (unsafe) {
    throw new GhViewError(`Not a repository: "${input}". Use owner/repo.`, 'GH_VIEW_BAD_REPO')
  }
}

/**
 * Normalize a repository argument.
 * Accepts `owner/repo`, a GitHub URL, or `undefined` (meaning "the default").
 * @returns {string | undefined} canonical `owner/repo`, or undefined.
 */
export function normalizeRepo(input) {
  if (input === undefined || input === null) return undefined
  let text = String(input).trim()
  if (text === '') return undefined
  // Accept full URLs: https://github.com/owner/repo(.git)(/issues/1)
  //
  // The URL branch validates both captured segments before returning. It used to
  // return immediately, which let `https://github.com/@C:\…/x` through as
  // `@C:\…/x` — and a value like that reaches `gh` argv as `-F owner=@C:\…`.
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(text)
  if (url) {
    const owner = url[1]
    const name = url[2].replace(/\.git$/i, '')
    assertSafeSegment(owner, input)
    assertSafeSegment(name, input)
    return `${owner}/${name}`
  }
  // SSH clone URLs: `git@github.com:owner/repo.git` (scp-like), plus the
  // `ssh://` and `git://` forms. Most checkouts on a developer machine use the
  // scp-like form, so leaving it out silently loses the default repository.
  const ssh = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/?#]+)/i.exec(text)
  if (ssh) {
    const owner = ssh[1]
    const name = ssh[2].replace(/\.git$/i, '')
    assertSafeSegment(owner, input)
    assertSafeSegment(name, input)
    return `${owner}/${name}`
  }
  text = text.replace(/^github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = text.split('/').filter(Boolean)
  if (parts.length >= 2 && REPO_PATTERN.test(parts[0]) && REPO_PATTERN.test(parts[1])) {
    assertSafeSegment(parts[0], input)
    assertSafeSegment(parts[1], input)
    return `${parts[0]}/${parts[1]}`
  }
  if (parts.length === 1 && REPO_PATTERN.test(parts[0])) {
    assertSafeSegment(parts[0], input)
    return parts[0]
  }
  throw new GhViewError(`Not a repository: "${input}". Use owner/repo.`, 'GH_VIEW_BAD_REPO')
}

/**
 * True when a git remote URL points at github.com.
 *
 * `normalizeRepo` also accepts bare `owner/repo` text and URL paths, so feeding
 * it every remote would read a local path remote such as `/srv/git/widgets.git`
 * as `srv/git` and pretend it is a GitHub repository. Remote detection therefore
 * checks the URL shape first.
 */
function isGitHubRemoteUrl(url) {
  const text = String(url ?? '').trim()
  return /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/(?:[^@/\s]+@)?github\.com\/|git:\/\/(?:[^@/\s]+@)?github\.com\/|(?:[^@/\s]+@)?github\.com[:/])/i.test(text)
}

/**
 * Parse an issue/PR reference.
 * Accepts `#123`, `123`, and `owner/repo#123`.
 * @returns {{repo: string | undefined, number: number}}
 */
export function parseRef(input, expected) {
  const text = String(input ?? '').trim()
  const match = /^(?:(?<repo>[\w.-]+\/[\w.-]+)\s*)?#?(?<number>\d+)$/.exec(text)
  if (!match?.groups) {
    const what = expected === 'pr' ? 'pull request' : expected === 'issue' ? 'issue' : 'issue or pull request'
    throw new GhViewError(`Not a ${what} reference: "${input}". Use #123 or owner/repo#123.`, 'GH_VIEW_BAD_REF')
  }
  return { repo: match.groups.repo, number: Number(match.groups.number) }
}

/** True when the `gh` CLI is on PATH and answers. */
let ghProbe
export function ghAvailable() {
  if (ghProbe === undefined) {
    ghProbe = run('gh', ['--version'], { timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
  }
  return ghProbe
}

/** Test hook: forget the cached `gh` probe so a fresh probe can be observed. */
export function resetGhProbe() {
  ghProbe = undefined
}

/** Parse JSON, tolerating the empty body `gh` prints for 204s. */
function parseJson(text, label) {
  const trimmed = String(text).trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new GhViewError(`GitHub returned a non-JSON body for ${label}.`, 'GH_VIEW_BAD_RESPONSE')
  }
}

/**
 * Fetch one REST path.
 * @param {string} path path below api.github.com, e.g. `/repos/o/r`.
 * @param {{source?: 'auto'|'gh'|'api', token?: string, searchParams?: Record<string, string|number>}} options
 */
export function apiGet(path, options = {}) {
  const { source = 'auto', token, searchParams } = options
  /*
   * Only relative paths below api.github.com are acceptable.
   *
   * `new URL('https://api.github.com/repos/../user')` normalizes to
   * `/user`, so a traversal in a "repository" name silently retargets the
   * request at a different endpoint — `/user` returns the token owner's account
   * for what was supposed to be a repository lookup.
   *
   * The check looks at *segments* rather than the raw string because the URL
   * parser also collapses `%2e%2e` and `. %2e`: `/repos/%2e%2e/user` reaches
   * `/user` without a literal `..` anywhere. A backslash is rejected too, since
   * the parser treats `\` as `/` in a special scheme. Percent escapes, `#` and
   * `?` are refused outright: nothing this plugin requests needs them, and they
   * are how a segment escapes into another path or query.
   */
  const requestPath = String(path ?? '')
  const unsafePath =
    !requestPath.startsWith('/')
    || /[\r\n%\\?#]/.test(requestPath)
    || requestPath.split('/').some((segment) => segment === '.' || segment === '..')
  if (unsafePath) {
    throw new GhViewError(`Refusing to request ${JSON.stringify(requestPath)} from the GitHub API.`, 'GH_VIEW_BAD_REPO')
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const suffix = query.size > 0 ? `?${query}` : ''

  const useGh = source === 'gh' || (source === 'auto' && ghAvailable())
  return (useGh ? ghAvailable().then((ok) => ok) : Promise.resolve(false)).then(async (ok) => {
    if (!ok) return apiFetch(path, suffix, { token })
    try {
      const stdout = await run('gh', ['api', `-X`, 'GET', `${path.replace(/^\//, '')}${suffix}`, '-H', 'Accept: application/vnd.github+json'])
      return parseJson(stdout, path)
    } catch (error) {
      const detail = String(error?.detail ?? error?.message ?? '')
      const failure = new GhViewError(
        classifyGhFailure(error, path),
        /404|Not Found/i.test(detail) ? 'GH_VIEW_NOT_FOUND' : 'GH_VIEW_GH_FAILED',
      )
      /*
       * A `gh` that exists but cannot answer — signed out, a rejected token, a
       * broken network — must not hide the anonymous REST path. `auto` falls
       * back for any failure and reports the more actionable diagnosis; an
       * explicit `source: 'gh'` still surfaces the gh error.
       */
      if (source !== 'auto') throw failure
      try {
        return await apiFetch(path, suffix, { token })
      } catch (restError) {
        // A rate limit or transport failure is the more actionable diagnosis.
        if (restError instanceof GhViewError
          && (restError.code === 'GH_VIEW_RATE_LIMIT' || restError.code === 'GH_VIEW_NETWORK')) {
          throw restError
        }
        throw failure
      }
    }
  })
}

/** Explain a `gh` failure in terms the model can act on. */
function classifyGhFailure(error, path) {
  const detail = error?.detail ?? error?.message ?? 'unknown error'
  if (/not logged|auth login|authentication|401|bad credentials/i.test(detail)) {
    return `The gh CLI is not signed in. Run \`gh auth login\`, or add a GITHUB_TOKEN to read private data (${path}).`
  }
  if (/Could not resolve host|network|timeout|ETIMEDOUT|ENOTFOUND/i.test(detail)) {
    return `Could not reach GitHub (${detail}).`
  }
  if (/404|Not Found/i.test(detail)) return `GitHub has no such resource: ${path}`
  return `gh api failed for ${path}: ${detail}`
}

/** Public REST call with the token that is available, if any. */
async function apiFetch(path, suffix, { token }) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-gh-view',
    'x-github-api-version': '2022-11-28',
  }
  const secret = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (secret) headers.authorization = `Bearer ${secret}`

  let response
  try {
    response = await fetch(`https://api.github.com${path}${suffix}`, { headers })
  } catch (error) {
    throw new GhViewError(`Could not reach api.github.com: ${error?.message ?? error}`, 'GH_VIEW_NETWORK')
  }
  if (response.status === 404) throw new GhViewError(`GitHub has no such resource: ${path}`, 'GH_VIEW_NOT_FOUND')
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const retryAfter = response.headers.get('retry-after')
    // 429 always means "slow down"; a 403 is a rate limit too when the quota is
    // spent or a retry delay is named. Only the remaining form is a refusal.
    if (response.status === 429 || remaining === '0' || retryAfter !== null) {
      throw new GhViewError(
        'The GitHub API rate limit is used up. Sign in with `gh auth login`, or set GITHUB_TOKEN.',
        'GH_VIEW_RATE_LIMIT',
      )
    }
    throw new GhViewError(`GitHub refused the request (HTTP ${response.status}).`, 'GH_VIEW_FORBIDDEN')
  }
  if (!response.ok) throw new GhViewError(`GitHub API returned HTTP ${response.status} for ${path}.`, 'GH_VIEW_HTTP')
  return parseJson(await response.text(), path)
}

/**
 * A tiny TTL cache: the panel and the agent often ask for the same card.
 *
 * Bounded in two ways, because the keys are caller-shaped — a `search?q=…`
 * request mints a key per query string, and the routes are reachable without
 * authentication, so an unbounded map is a memory-growth path. Entries expire
 * by TTL and are swept out; the hard cap evicts the oldest insertion when a
 * burst outruns the sweep.
 */
const cache = new Map()
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 200
/** Remote detection is stable, and each miss costs a `git` process (~100ms). */
const REMOTES_TTL_MS = 10 * 60_000

function sweepCache() {
  const now = Date.now()
  // Each entry carries its own deadline: remote detection is cached far longer
  // than an API response, so a single hard-coded TTL here would evict it early.
  for (const [key, entry] of cache) {
    if (now - entry.at >= (entry.ttl ?? CACHE_TTL_MS)) cache.delete(key)
  }
  // `Map` iterates in insertion order, so the first keys are the oldest.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

function cached(key, producer) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = producer()
  cache.set(key, { at: Date.now(), value })
  if (cache.size > CACHE_MAX_ENTRIES) sweepCache()
  /*
   * A rejected entry must not be cached, or one transient failure sticks — but
   * only drop it if it is still the entry for this key. An evicted entry whose
   * promise rejects later would otherwise delete the newer, good value that
   * replaced it.
   */
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key)
  })
  return value
}

/** Drop every cached response. */
export function clearCache() {
  cache.clear()
}

/**
 * Isolation suffix for one caller's credentials and source.
 *
 * The cache above is module-level, so two callers in one process share it. A
 * data key must record which credential read it, or a caller using a different
 * token — or explicitly asking for the anonymous REST source — could receive
 * the previous caller's private result. Only a short digest of the token is
 * kept in the key, never the token itself.
 */
function cacheScope(options = {}) {
  const source = options.source === 'gh' || options.source === 'api' ? options.source : 'auto'
  // The REST path also accepts GITHUB_TOKEN / GH_TOKEN from the environment, so
  // "no option" is not the same identity as "explicitly anonymous": hash the
  // effective token and mark an explicit empty one apart. Otherwise a private
  // read cached under the ambient token would answer a caller that asked for
  // public data. (The `gh` login is the process's single login; source `auto`
  // and `gh` share it.)
  const explicit = typeof options.token === 'string' ? options.token : undefined
  const effective = explicit ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const identity = effective === ''
    ? (explicit === '' ? 'anon-explicit' : 'anon')
    : createHash('sha256').update(effective).digest('hex').slice(0, 12)
  return `|${source}|${identity}`
}

/**
 * Resolve the credential once per call.
 *
 * The cache key records the identity a read belongs to, while the request reads
 * the environment again when it runs. A caller can rotate GITHUB_TOKEN between
 * those two moments, which would let one identity's data land under another's
 * key; snapshotting the token into the options keeps them in step. An explicit
 * `token: ''` still means "anonymous", and an explicit token is never replaced.
 *
 * @param {object} options caller options
 * @returns {object} the same options, with the effective token filled in
 */
function resolveOptions(options = {}) {
  if (typeof options.token === 'string') return options
  // Snapshot the absence too: a credential that appears while the request is
  // in flight must not be used under a cache key that recorded "anonymous".
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  return { ...options, token }
}

/** Fields the repo card needs. */
const REPO_FIELDS = [
  'full_name', 'description', 'html_url', 'homepage', 'language', 'license',
  'stargazers_count', 'watchers_count', 'subscribers_count', 'forks_count',
  'open_issues_count', 'topics', 'default_branch', 'created_at', 'updated_at',
  'pushed_at', 'archived', 'private', 'visibility', 'size', 'fork', 'owner',
].join(',')

/**
 * Repository overview.
 * @returns normalized repo facts for the renderer.
 */
export function getRepo(repo, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  if (name === undefined || !name.includes('/')) {
    throw new GhViewError('A repository is required for this view. Use owner/repo.', 'GH_VIEW_BAD_REPO')
  }
  return cached(`repo:${name}${cacheScope(options)}`, async () => {
    /*
     * All four reads go out together. The two searches used to be awaited after
     * the repository call, which serialized two full round trips for no reason —
     * they are independent, and a repository overview that takes 3 seconds is
     * what made a workspace switch feel broken.
     */
    const [data, releases, issueCounts, prCounts] = await Promise.all([
      apiGet(`/repos/${name}`, options),
      apiGet(`/repos/${name}/releases`, { ...options, searchParams: { per_page: 1 } }).catch(() => []),
      apiGet('/search/issues', {
        ...options,
        searchParams: { q: `repo:${name} type:issue state:open`, per_page: 1 },
      }).catch(() => null),
      apiGet('/search/issues', {
        ...options,
        searchParams: { q: `repo:${name} type:pr state:open`, per_page: 1 },
      }).catch(() => null),
    ])
    if (!data) throw new GhViewError(`GitHub has no repository named ${name}.`, 'GH_VIEW_NOT_FOUND')

    return {
      kind: 'repo',
      fullName: data.full_name,
      owner: data.owner?.login,
      ownerAvatar: data.owner?.avatar_url,
      description: data.description ?? '',
      url: data.html_url,
      homepage: data.homepage ?? '',
      language: data.language ?? '',
      license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.name : '',
      stars: data.stargazers_count ?? 0,
      watchers: data.subscribers_count ?? data.watchers_count ?? 0,
      forks: data.forks_count ?? 0,
      openIssues: issueCounts?.total_count ?? null,
      openPulls: prCounts?.total_count ?? null,
      topics: Array.isArray(data.topics) ? data.topics : [],
      defaultBranch: data.default_branch ?? '',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      pushedAt: data.pushed_at,
      archived: Boolean(data.archived),
      isPrivate: Boolean(data.private),
      isFork: Boolean(data.fork),
      latestRelease: Array.isArray(releases) && releases[0]
        ? { tag: releases[0].tag_name, name: releases[0].name, at: releases[0].published_at }
        : null,
    }
  }).catch((error) => { throw asGhViewError(error) })
}

/** Turn any thrown value into a GhViewError. */
function asGhViewError(error) {
  if (error instanceof GhViewError) return error
  return new GhViewError(error?.message ?? String(error), 'GH_VIEW_ERROR')
}

/** Normalize one label out of the REST shape. */
function labelOf(label) {
  if (typeof label === 'string') return { name: label, color: '' }
  return { name: label?.name ?? '', color: String(label?.color ?? '') }
}

/** Normalize one user out of the REST shape. */
function userOf(user) {
  return { login: user?.login ?? '', avatar: user?.avatar_url ?? '' }
}

/** Trim a markdown body to what a card can show. */
export function clipBody(body, limit = 1600) {
  const text = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit).trimEnd()}…`, truncated: true }
}

/**
 * Reduce markdown to plain prose *before* clipping.
 *
 * Clipping raw markdown can cut a link in half and leave `[label](https://…`
 * as visible text, so reply excerpts strip the markup first and then take the
 * prefix.
 */
export function plainExcerpt(body, limit) {
  const text = String(body ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(```|~~~).*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`
}

/**
 * One issue: body, author, labels, comment count, and a few replies.
 */
export function getIssue(repo, number, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  return cached(`issue:${name}:${number}${cacheScope(options)}`, async () => {
    const [issue, comments] = await Promise.all([
      apiGet(`/repos/${name}/issues/${number}`, options),
      apiGet(`/repos/${name}/issues/${number}/comments`, { ...options, searchParams: { per_page: 30 } }).catch(() => []),
    ])
    if (!issue) throw new GhViewError(`No issue #${number} in ${name}.`, 'GH_VIEW_NOT_FOUND')
    if (issue.pull_request) {
      // The REST issues endpoint answers for PRs too; the caller asked for an issue.
      throw new GhViewError(`#${number} in ${name} is a pull request, not an issue.`, 'GH_VIEW_WRONG_KIND')
    }
    const body = clipBody(issue.body)
    return {
      kind: 'issue',
      repo: name,
      number: issue.number,
      title: issue.title ?? '',
      state: issue.state ?? 'open',
      stateReason: issue.state_reason ?? '',
      url: issue.html_url,
      author: userOf(issue.user),
      labels: (issue.labels ?? []).map(labelOf),
      comments: issue.comments ?? 0,
      body: body.text,
      bodyTruncated: body.truncated,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      isLocked: Boolean(issue.locked),
      milestone: issue.milestone?.title ?? '',
      assignees: (issue.assignees ?? []).map((a) => a?.login).filter(Boolean),
      // The panel renders markdown and collapses long replies itself, so the
      // body travels whole; the card path flattens it to plain text at draw
      // time. Clipping here would throw away markdown the UI could render.
      replies: (Array.isArray(comments) ? comments : []).slice(0, 30).map((c) => ({
        author: userOf(c.user),
        body: String(c.body ?? ''),
        createdAt: c.created_at,
      })),
    }
  }).catch((error) => { throw asGhViewError(error) })
}

/** Collapse a check rollup into the few numbers a card shows. */
/**
 * Collapse a check rollup into both a summary and the per-check detail a reader
 * can expand.
 *
 * The summary answers "is this PR green"; the `items` list answers "which one
 * failed", which is the next question and the reason the panel makes the badges
 * expandable rather than a bare count.
 */
function summarizeChecks(rollup) {
  const buckets = { success: 0, failure: 0, pending: 0, skipped: 0, neutral: 0 }
  const failing = []
  const items = []
  for (const check of Array.isArray(rollup) ? rollup : []) {
    if (check?.__typename === 'StatusContext') {
      const state = String(check.state ?? '').toUpperCase()
      const name = check.context ?? 'status'
      let bucket = 'pending'
      if (state === 'SUCCESS') bucket = 'success'
      else if (state === 'FAILURE' || state === 'ERROR') { bucket = 'failure'; failing.push(name) }
      buckets[bucket] += 1
      items.push({ name, state: bucket, url: check.targetUrl ?? check.target_url ?? '' })
      continue
    }
    const raw = String(check?.conclusion ?? check?.status ?? '').toLowerCase()
    let bucket = 'pending'
    if (['success', 'neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(raw)) {
      if (raw === 'success') bucket = 'success'
      else if (raw === 'neutral') bucket = 'neutral'
      else if (raw === 'skipped') bucket = 'skipped'
      else bucket = 'failure'
    }
    buckets[bucket] += 1
    const name = check?.name ?? check?.context ?? 'check'
    if (bucket === 'failure') failing.push(name)
    items.push({ name, state: bucket, url: check?.html_url ?? check?.details_url ?? '' })
  }
  const total = Object.values(buckets).reduce((sum, n) => sum + n, 0)
  let state = 'none'
  if (total > 0) {
    if (buckets.failure > 0) state = 'failing'
    else if (buckets.pending > 0) state = 'pending'
    else state = 'passing'
  }
  return { ...buckets, total, state, failing: failing.slice(0, 6), items: items.slice(0, 100) }
}

/**
 * One pull request: size, checks, reviews and approvals.
 */
export function getPull(repo, number, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  return cached(`pull:${name}:${number}${cacheScope(options)}`, async () => {
    const [pull, reviews, comments] = await Promise.all([
      apiGet(`/repos/${name}/pulls/${number}`, options),
      apiGet(`/repos/${name}/pulls/${number}/reviews`, { ...options, searchParams: { per_page: 100 } }).catch(() => []),
      apiGet(`/repos/${name}/issues/${number}/comments`, { ...options, searchParams: { per_page: 30 } }).catch(() => []),
    ])
    if (!pull) throw new GhViewError(`No pull request #${number} in ${name}.`, 'GH_VIEW_NOT_FOUND')

    // Check runs and the legacy commit-status API are separate sources, and a
    // repository can use both at the same time: read both so a failing legacy
    // status cannot hide behind a green check-run rollup. Each call is
    // best-effort; a missing endpoint must not fail the whole card.
    const [checkRuns, combined] = await Promise.all([
      apiGet(`/repos/${name}/commits/${pull.head?.sha}/check-runs`, {
        ...options,
        searchParams: { per_page: 100 },
      }).catch(() => null),
      apiGet(`/repos/${name}/commits/${pull.head?.sha}/status`, options).catch(() => null),
    ])
    const runItems = Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : []
    // The check-runs page is capped at 100; the combined status carries one
    // entry per context, so together they cover both CI styles.
    const rollup = [
      ...runItems.map((run) => ({
        conclusion: run.conclusion,
        status: run.status,
        name: run.name,
        // The panel links each check to its log; the field differs by source.
        html_url: run.html_url,
        details_url: run.details_url,
      })),
      ...(combined?.statuses ?? []).map((status) => ({
        __typename: 'StatusContext',
        state: status.state,
        context: status.context,
        target_url: status.target_url,
      })),
    ]

    const approvals = new Set()
    const changesRequested = new Set()
    let reviewComments = 0
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const login = review?.user?.login
      if (!login) continue
      const state = String(review.state ?? '').toUpperCase()
      if (state === 'APPROVED') { approvals.add(login); changesRequested.delete(login) }
      else if (state === 'CHANGES_REQUESTED') { changesRequested.add(login); approvals.delete(login) }
      else if (state === 'COMMENTED') reviewComments += 1
    }

    const body = clipBody(pull.body, 1400)
    const merged = Boolean(pull.merged)
    let state = 'open'
    if (pull.merged) state = 'merged'
    else if (pull.state === 'closed') state = 'closed'
    else if (pull.draft) state = 'draft'

    // The branch's required-review verdict only exists in GraphQL. It is one
    // cheap query and it is what tells "review required" apart from "approved",
    // so it is worth the round trip; a failure leaves it empty. An explicit
    // `source: 'api'` caller is not answered through the host's `gh` login.
    let reviewDecision = ''
    if ((options.source ?? 'auto') !== 'api' && await ghAvailable()) {
      try {
        const stdout = await run('gh', [
          'api', 'graphql',
          '-f', `query=query PullDecision($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } } }`,
          '-F', `owner=${name.split('/')[0]}`,
          '-F', `repo=${name.split('/')[1]}`,
          '-F', `number=${number}`,
        ], { timeout: 20_000 })
        const parsed = parseJson(stdout, 'graphql/pullDecision')
        reviewDecision = String(parsed?.data?.repository?.pullRequest?.reviewDecision ?? '')
      } catch {
        // absent verdict is fine; the raw approval count still shows
      }
    }

    return {
      kind: 'pr',
      repo: name,
      number: pull.number,
      title: pull.title ?? '',
      state,
      merged,
      isDraft: Boolean(pull.draft),
      url: pull.html_url,
      author: userOf(pull.user),
      labels: (pull.labels ?? []).map(labelOf),
      body: body.text,
      bodyTruncated: body.truncated,
      branch: { head: pull.head?.ref ?? '', base: pull.base?.ref ?? '' },
      commits: pull.commits ?? 0,
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? 0,
      comments: (pull.comments ?? 0) + (pull.review_comments ?? 0),
      reviewComments,
      approvals: [...approvals],
      changesRequested: [...changesRequested],
      // REST does not expose the branch's required-review verdict; GraphQL does,
      // and the detail card needs it to say "required review pending" rather
      // than the misleading "awaiting review".
      reviewDecision,
      checks: summarizeChecks(rollup),
      mergeable: pull.mergeable,
      mergeableState: pull.mergeable_state ?? '',
      assignees: (pull.assignees ?? []).map((person) => person?.login).filter(Boolean),
      milestone: pull.milestone?.title ?? '',
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      mergedAt: pull.merged_at,
      closedAt: pull.closed_at,
      replies: (Array.isArray(comments) ? comments : []).slice(0, 30).map((c) => ({
        author: userOf(c.user),
        body: String(c.body ?? ''),
        createdAt: c.created_at,
      })),
    }
  }).catch((error) => { throw asGhViewError(error) })
}

/**
 * Resolve a bare reference into issue or pull request without the caller
 * having to know which one it is.
 */
export function getAnyRef(repo, number, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  return cached(`any:${name}:${number}${cacheScope(options)}`, async () => {
    const data = await apiGet(`/repos/${name}/issues/${number}`, options)
    if (!data) throw new GhViewError(`No issue or pull request #${number} in ${name}.`, 'GH_VIEW_NOT_FOUND')
    return data.pull_request
      ? getPull(name, number, options)
      : getIssue(name, number, options)
  }).catch((error) => { throw asGhViewError(error) })
}

/**
 * Normalize a list filter once, so the cache key and the request agree.
 * @param {{kind?: string, state?: string, labels?: string, search?: string,
 *          sort?: string, limit?: number, offset?: number, badges?: boolean}} filter
 */
function normalizeListFilter(filter = {}) {
  return {
    kind: filter.kind ?? 'any',
    state: filter.state ?? 'open',
    limit: Math.min(Math.max(Number(filter.limit) || 15, 1), 50),
    labels: filter.labels ?? '',
    search: String(filter.search ?? '').trim(),
    // GitHub's own two orderings: `updated` is the default everywhere, `created`
    // is what a reader asking for "newest" usually means.
    sort: filter.sort === 'created' ? 'created' : 'updated',
    // Paging: `offset` is "rows already shown", so a "load more" asks for the
    // next page instead of the same first page.
    offset: Math.max(Number(filter.offset) || 0, 0),
    badges: filter.badges !== false,
  }
}

/**
 * Cache key for one list read.
 *
 * Exported so a test can prove the two-pass panel load really is two cache
 * entries: `badges=0` returns rows alone, the second pass adds the per-row
 * badges, and a key that ignored `badges` would make the second pass a no-op on
 * a cached rows-only answer.
 */
export function listCacheKey(name, filter, options = {}) {
  const q = normalizeListFilter(filter)
  // Serialized as a tuple, not colon-joined text: labels and search terms may
  // contain colons, which would let two different filters share one key.
  return `list:${JSON.stringify([name, q.kind, q.state, q.labels, q.search, q.sort, q.limit, q.offset, q.badges ? 1 : 0])}${cacheScope(options)}`
}

/**
 * List open/closed issues or pull requests.
 * @param {{kind: 'issue'|'pr'|'any', state?: string, labels?: string, limit?: number}} filter
 */
export function listItems(repo, filter, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  const { kind, state, limit, labels, search, sort, offset, badges } = normalizeListFilter(filter)
  const key = listCacheKey(name, filter, options)
  return cached(key, async () => {
    // A repository's issue endpoint returns issues AND pull requests merged and
    // sorted by recency, so in a busy repository the newest page can be all
    // pull requests. Asking for one kind therefore has to filter server-side:
    // the search endpoint takes the `type:` qualifier, and it also pages, so a
    // kind request never comes back short. A title filter or arbitrary label
    // set needs the same endpoint, so any of those routes through search too.
    const wantsSearch = kind === 'issue' || kind === 'pr' || search !== ''
    if (wantsSearch) {
      // A pull-request page answers in one GraphQL round trip, including the
      // review verdict and check rollup REST needs extra requests for. It falls
      // back to the REST path when the CLI is absent or GraphQL is refused.
      // A title filter stays on the REST search path: GraphQL has no server-side
      // title filter here, so filtering a fetched prefix would hide matches that
      // live below it. An explicit `source: 'api'` caller must not be answered
      // through the host's `gh` login.
      if (kind === 'pr' && labels === '' && search === '' && (options.source ?? 'auto') !== 'api' && (await ghAvailable())) {
        try {
          // GraphQL pages by cursor; the "after" item needs the previous page's
          // last node, so ask for everything up to this page and slice.
          const pulled = await listPullsViaGraphql(name, { state, limit: offset + limit, labels, search, sort }, options)
          if (pulled !== null) {
            const ordered = newestFirst(pulled, sort)
            return { kind: 'list-pr', repo: name, state, items: ordered.slice(offset, offset + limit) }
          }
        } catch {
          // fall through to the REST path
        }
      }

      const qualifiers = [`repo:${name}`]
      // GitHub's search syntax has no `state:all`: the qualifier only accepts
      // `open` or `closed`, and an unsupported value matches nothing at all.
      // Omitting it is what "all" means there.
      if (state !== 'all') qualifiers.push(`state:${state}`)
      if (kind === 'issue' || kind === 'pr') qualifiers.push(`type:${kind}`)
      for (const label of labels.split(',').map((value) => value.trim()).filter(Boolean)) {
        qualifiers.push(`label:"${label}"`)
      }
      // `in:title` is GitHub's own qualifier, so the filter behaves the way the
      // web UI's search box does rather than being a bespoke substring match.
      if (search !== '') qualifiers.push(`in:title ${search}`)
      // The search endpoint pages by page number, not offset.
      const page = Math.floor(offset / limit) + 1
      const found = await apiGet('/search/issues', {
        ...options,
        searchParams: { q: qualifiers.join(' '), per_page: limit, sort, order: 'desc', page },
      })
      const items = (found?.items ?? []).slice(0, limit).map(toListItem)
      // `badges: false` skips the per-row lookups so the first paint is fast;
      // the panel asks for them in a second, non-blocking pass.
      if (badges) await enrichItems(items, name, kind, options)
      return { kind: kind === 'pr' ? 'list-pr' : kind === 'issue' ? 'list-issue' : 'list', repo: name, state, items: newestFirst(items, sort) }
    }

    const rows = await apiGet(`/repos/${name}/issues`, {
      ...options,
      searchParams: { state, per_page: Math.min(limit, 100), labels, sort, direction: 'desc', page: Math.floor(offset / limit) + 1 },
    })
    const items = (Array.isArray(rows) ? rows : []).slice(0, limit).map(toListItem)
    if (badges) await enrichItems(items, name, 'any', options)
    return { kind: 'list', repo: name, state, items: newestFirst(items, sort) }
  }).catch((error) => { throw asGhViewError(error) })
}

/**
 * Run `worker` over `items` with a small concurrency ceiling.
 *
 * The per-row lookups are independent network calls; firing them all at once
 * trips GitHub's secondary rate limit on a 20-row page, and running them
 * strictly in series makes a PR list take five seconds. Four at a time is the
 * balance the REST docs recommend for concurrent requests.
 *
 * @template T
 * @param {readonly T[]} items work items
 * @param {number} limit how many run at once
 * @param {(item: T) => Promise<void>} worker per-item task
 */
async function pool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * Enforce newest-first ordering on a finished list.
 *
 * Each source is asked to sort, but a source that ignores the parameter (or a
 * later enrichment that replaces a row) would silently break the order the user
 * sees. Sorting the final array makes the contract local to this module instead
 * of a hope about the API.
 *
 * @template {{ updatedAt?: string, createdAt?: string }} T
 * @param {T[]} items rows to order in place
 * @param {'updated'|'created'} field which timestamp decides
 * @returns {T[]} the same array, ordered newest first
 */
function newestFirst(items, field) {
  const stamp = (item) => {
    const raw = field === 'created' ? (item.createdAt ?? item.updatedAt) : (item.updatedAt ?? item.createdAt)
    const value = Date.parse(String(raw ?? ''))
    return Number.isFinite(value) ? value : 0
  }
  return items.sort((left, right) => stamp(right) - stamp(left))
}

/**
 * List a repository's pull requests through one GraphQL query.
 *
 * The REST route needs three requests per row (pull, reviews, check-runs) and
 * `gh` pays a process spawn for each, which made a 20-row PR list take six
 * seconds. GraphQL answers the whole page in one round trip and carries fields
 * REST does not expose at all: `reviewDecision` (GitHub's own
 * required-reviews verdict) and the commit's `statusCheckRollup`.
 *
 * @param {string} name canonical owner/repo
 * @param {{state: string, limit: number, labels: string, search: string}} filter
 * @param {object} options source/token options
 * @returns {Promise<Array<object>>} list items, or null when GraphQL is unavailable
 */
async function listPullsViaGraphql(name, filter, options) {
  const [owner, repo] = name.split('/')
  // GitHub models "merged" as its own state: a merged PR is not CLOSED, so a
  // closed list that asks only for CLOSED silently loses every merged PR that
  // the web UI shows under Closed.
  const states = filter.state === 'all'
    ? ['OPEN', 'CLOSED', 'MERGED']
    : filter.state === 'closed'
      ? ['CLOSED', 'MERGED']
      : ['OPEN']
  // Written as one template literal, not joined fragments: GraphQL is
  // whitespace-insensitive, so a missing separator silently fuses two field
  // names (`mergeable` + `headRefName` => `mergeableheadRefName`) and the whole
  // query is rejected.
  const orderBy = filter.sort === 'created'
    ? '{ field: CREATED_AT, direction: DESC }'
    : '{ field: UPDATED_AT, direction: DESC }'
  const query = `
    query PullList($owner: String!, $repo: String!, $first: Int!, $states: [PullRequestState!], $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(first: $first, states: $states, orderBy: ${orderBy}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            isDraft
            state
            additions
            deletions
            changedFiles
            reviewDecision
            mergeable
            headRefName
            baseRefName
            updatedAt
            createdAt
            url
            author { login avatarUrl }
            labels(first: 10) { nodes { name color } }
            assignees(first: 5) { nodes { login } }
            comments { totalCount }
            reviews(first: 0) { totalCount }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
        }
      }
    }
  `
  // One GraphQL page is at most 100 nodes, so "Load more" past 100 rows needs a
  // cursor walk rather than a bigger `first`. 500 rows is the ceiling this
  // module will spend on one list read.
  const wanted = Math.min(Math.max(Number(filter.limit) || 20, 1), 500)
  const MAX_PAGES = 10
  const nodes = []
  const seen = new Set()
  const seenCursors = new Set()
  let after = null
  let pages = 0
  while (nodes.length < wanted && pages < MAX_PAGES) {
    pages += 1
    const first = Math.min(100, wanted - nodes.length)
    const args = [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `first=${first}`,
      ...states.map((state) => ['-f', `states[]=${state}`]).flat(),
    ]
    if (after !== null) args.push('-f', `after=${after}`)
    const stdout = await run('gh', args, { timeout: 30_000 })
    const data = parseJson(stdout, 'graphql/pullRequests')
    const connection = data?.data?.repository?.pullRequests
    if (!Array.isArray(connection?.nodes)) return null
    const before = nodes.length
    for (const node of connection.nodes) {
      const key = String(node?.number)
      if (seen.has(key)) continue
      seen.add(key)
      nodes.push(node)
    }
    if (connection.pageInfo?.hasNextPage !== true) break
    const next = connection.pageInfo.endCursor
    // Bound requests as well as rows: a page that adds nothing, a repeated
    // cursor, or a cursor that does not advance must end the walk.
    if (typeof next !== 'string' || next === '' || seenCursors.has(next)) break
    if (nodes.length === before) break
    seenCursors.add(next)
    after = next
  }

  // No title filter here: the caller only takes this path when `search` is
  // empty, because filtering a fetched prefix would hide matches below it.
  return nodes
    .map((node) => {
      const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
      // One GraphQL page gives the aggregate state only: do not fabricate a
      // single check from it, or the row would claim "1 check ok". The panel
      // shows the state, and the detail page carries the real counts.
      const checks = {
        state: rollup === 'SUCCESS' ? 'passing'
          : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failing'
            : rollup === 'PENDING' ? 'pending' : 'none',
        success: 0,
        failure: 0,
        pending: 0,
        total: 0,
        failing: [],
        items: [],
        aggregate: true,
      }
      const decision = String(node.reviewDecision ?? '')
      return {
        number: node.number,
        title: node.title ?? '',
        isPull: true,
        draft: Boolean(node.isDraft),
        state: node.state === 'MERGED' ? 'merged' : String(node.state ?? 'open').toLowerCase(),
        author: node.author?.login ?? '',
        authorAvatar: node.author?.avatarUrl ?? '',
        labels: (node.labels?.nodes ?? []).map((label) => ({ name: label.name, color: String(label.color ?? '') })),
        assignees: (node.assignees?.nodes ?? []).map((person) => person.login).filter(Boolean),
        comments: node.comments?.totalCount ?? 0,
        reviews: node.reviews?.totalCount ?? 0,
        // GitHub's own verdict: APPROVED / REVIEW_REQUIRED / CHANGES_REQUESTED.
        reviewDecision: decision,
        additions: node.additions ?? 0,
        deletions: node.deletions ?? 0,
        changedFiles: node.changedFiles ?? 0,
        head: node.headRefName ?? '',
        base: node.baseRefName ?? '',
        merged: node.state === 'MERGED',
        mergeable: node.mergeable === 'MERGEABLE' ? true : node.mergeable === 'CONFLICTING' ? false : undefined,
        mergeableState: node.mergeable === 'CONFLICTING' ? 'conflicting' : '',
        checks,
        updatedAt: node.updatedAt,
        createdAt: node.createdAt,
        url: node.url,
      }
    })
}

/**
 * Add the PR-only summary a list row shows: check rollup, review state, and —
 * for an issue — how many pull requests reference it.
 *
 * This is best-effort: a failure leaves the field absent rather than failing the
 * whole list, because a list that will not render because one check-run fetch
 * 502'd is worse than a list with one missing badge.
 *
 * @param {Array<object>} items rows to augment in place
 * @param {string} name canonical owner/repo
 * @param {'issue'|'pr'|'any'} kind which rows were requested
 * @param {object} options source/token options forwarded to the API
 */
async function enrichItems(items, name, kind, options) {
  const pulls = items.filter((item) => item.isPull).slice(0, 15)
  const issues = kind === 'any' ? [] : items.filter((item) => !item.isPull).slice(0, 8)

  // One row's PR detail: the pull itself, its reviews and its check rollup, all
  // in parallel — they are independent and each row needs all three. The check
  // rollup needs the head SHA from the pull, so it waits on that one response.
  await pool(pulls, 4, async (item) => {
    try {
      const [pull, reviews] = await Promise.all([
        apiGet(`/repos/${name}/pulls/${item.number}`, options),
        apiGet(`/repos/${name}/pulls/${item.number}/reviews`, { ...options, searchParams: { per_page: 100 } }).catch(() => []),
      ])
      if (!pull) return
      const sha = pull.head?.sha
      item.additions = pull.additions ?? 0
      item.deletions = pull.deletions ?? 0
      item.changedFiles = pull.changed_files ?? 0
      item.head = pull.head?.ref ?? ''
      item.base = pull.base?.ref ?? ''
      item.merged = Boolean(pull.merged)
      item.draft = Boolean(pull.draft)
      item.mergeable = pull.mergeable
      item.mergeableState = pull.mergeable_state ?? ''
      if (pull.merged) item.state = 'merged'
      else if (pull.state === 'closed') item.state = 'closed'

      const approvals = new Set()
      const blocked = new Set()
      for (const review of Array.isArray(reviews) ? reviews : []) {
        const login = review?.user?.login
        if (!login) continue
        const state = String(review.state ?? '').toUpperCase()
        if (state === 'APPROVED') { approvals.add(login); blocked.delete(login) }
        else if (state === 'CHANGES_REQUESTED') { blocked.add(login); approvals.delete(login) }
      }
      item.approvals = approvals.size
      item.changesRequested = blocked.size

      if (sha !== undefined) {
        const checksRaw = await apiGet(`/repos/${name}/commits/${sha}/check-runs`, {
          ...options,
          searchParams: { per_page: 100 },
        }).catch(() => null)
        item.checks = summarizeChecks(
          checksRaw?.check_runs
            ? checksRaw.check_runs.map((run) => ({ conclusion: run.conclusion, status: run.status, name: run.name }))
            : [],
        )
      }
    } catch {
      // leave the row as it is
    }
  })

  // An issue's linked pull requests, from its timeline.
  await pool(issues, 4, async (item) => {
    try {
      const timeline = await apiGet(`/repos/${name}/issues/${item.number}/timeline`, {
        ...options,
        searchParams: { per_page: 100 },
      })
      const linked = (Array.isArray(timeline) ? timeline : [])
        .filter((event) => event?.event === 'cross-referenced' && event?.source?.issue?.pull_request)
        .map((event) => ({
          number: event.source.issue.number,
          title: event.source.issue.title ?? '',
          draft: Boolean(event.source.issue.draft),
        }))
      if (linked.length > 0) item.linkedPulls = linked.slice(0, 5)
    } catch {
      // timeline is preview-gated on some sources; absence is fine
    }
  })
}

/** Normalize one row from the issue or search endpoint into a list item. */
function toListItem(row) {
  return {
    number: row.number,
    title: row.title ?? '',
    isPull: Boolean(row.pull_request),
    // A draft is only meaningful for a pull request; the search row carries it
    // as `draft`, the REST issue row nests nothing.
    draft: Boolean(row.draft ?? row.pull_request?.draft),
    state: row.state ?? 'open',
    author: row.user?.login ?? '',
    repository: row.repository_url ? String(row.repository_url).replace('https://api.github.com/repos/', '') : '',
    labels: (row.labels ?? []).map(labelOf),
    assignees: (row.assignees ?? []).map((a) => a?.login).filter(Boolean),
    comments: row.comments ?? 0,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    url: row.html_url,
  }
}

/**
 * Search issues and pull requests across repositories.
 */
export function searchItems(query, options = {}) {
  options = resolveOptions(options)
  const text = String(query ?? '').trim()
  if (text === '') throw new GhViewError('A search query is required.', 'GH_VIEW_BAD_QUERY')
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 30)
  return cached(`search:${text}:${limit}${cacheScope(options)}`, async () => {
    const data = await apiGet('/search/issues', {
      ...options,
      searchParams: { q: text, per_page: limit, sort: 'updated', order: 'desc' },
    })
    const items = (data?.items ?? []).slice(0, limit).map((row) => ({
      number: row.number,
      title: row.title ?? '',
      isPull: Boolean(row.pull_request),
      state: row.state ?? 'open',
      author: row.user?.login ?? '',
      repository: row.repository_url ? String(row.repository_url).replace('https://api.github.com/repos/', '') : '',
      comments: row.comments ?? 0,
      updatedAt: row.updated_at,
      url: row.html_url,
    }))
    return { kind: 'search', query: text, total: data?.total_count ?? items.length, items }
  }).catch((error) => { throw asGhViewError(error) })
}

/**
 * Read the GitHub repositories a directory's git remotes point at.
 *
 * A checkout commonly has `origin` (your fork) and `upstream` (the canonical
 * repository), and they are different repositories. Returning every remote lets
 * the caller prefer one by name instead of guessing, and lets the UI offer a
 * choice when both exist.
 *
 * Results are memoized per directory: spawning `git` costs ~100ms on Windows and
 * the panel re-asks on every workspace switch, which made the workspace picker
 * feel unresponsive. `clearCache()` forgets these too.
 *
 * @param {string | undefined} cwd absolute directory to inspect
 * @returns {Promise<{origin: string|null, upstream: string|null, remotes: Array<{name: string, repo: string}>}>}
 */
export async function detectRemotes(cwd) {
  const empty = { origin: null, upstream: null, remotes: [] }
  if (!cwd) return empty
  const key = `remotes:${cwd}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < REMOTES_TTL_MS) return hit.value
  const value = readRemotes(cwd)
  cache.set(key, { at: Date.now(), ttl: REMOTES_TTL_MS, value })
  // This path writes to the same map as `cached()`, so it must respect the cap
  // too — otherwise a burst of workspace switches could grow it past the bound.
  if (cache.size > CACHE_MAX_ENTRIES) sweepCache()
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key)
  })
  return value
}

/** The uncached read of one directory's remotes. */
async function readRemotes(cwd) {
  const empty = { origin: null, upstream: null, remotes: [] }
  let text
  try {
    text = await run('git', ['-C', cwd, 'remote', '-v'], { timeout: 6_000 })
  } catch {
    return empty
  }
  // `git remote -v` prints one line per URL: "<name>\t<url> (fetch|push)".
  // Fetch URLs are the canonical ones; push URLs are often rewritten, so they
  // are only a fallback when a remote has no fetch line.
  const fetched = new Map()
  const pushed = new Map()
  for (const line of String(text).split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const [, name, url, kind] = match
    // A local-path or mirror remote is not GitHub; normalizing it without this
    // guard would mistake `/srv/git/widgets.git` for `srv/git`.
    if (!isGitHubRemoteUrl(url)) continue
    let repo
    try {
      repo = normalizeRepo(url)
    } catch {
      continue // not a GitHub remote (mirror, ssh alias, local path)
    }
    if (!repo || !repo.includes('/')) continue
    if (kind === 'fetch') fetched.set(name, repo)
    else pushed.set(name, repo)
  }
  const remotes = []
  for (const [name, repo] of fetched) remotes.push({ name, repo })
  for (const [name, repo] of pushed) {
    if (!fetched.has(name)) remotes.push({ name, repo })
  }
  const pick = (name) => remotes.find((remote) => remote.name === name)?.repo ?? null
  return { origin: pick('origin'), upstream: pick('upstream'), remotes }
}

/**
 * Read a repository's README as markdown.
 *
 * The contents API returns base64; it also answers 404 for a repository with no
 * README, which is a normal state rather than an error, so the caller gets
 * `null` and renders its own empty text.
 *
 * @param {string} repo canonical owner/repo
 * @returns {Promise<{name: string, markdown: string, htmlUrl: string} | null>}
 */
export function getReadme(repo, options = {}) {
  options = resolveOptions(options)
  const name = normalizeRepo(repo)
  if (name === undefined || !name.includes('/')) {
    throw new GhViewError('A repository is required to read its README.', 'GH_VIEW_BAD_REPO')
  }
  return cached(`readme:${name}${cacheScope(options)}`, async () => {
    let data
    try {
      data = await apiGet(`/repos/${name}/readme`, options)
    } catch (error) {
      if (error instanceof GhViewError && error.code === 'GH_VIEW_NOT_FOUND') return null
      throw error
    }
    if (!data) return null
    // `content` is base64 with embedded newlines; decode it as UTF-8.
    const raw = String(data.content ?? '').replace(/\n/g, '')
    const markdown = Buffer.from(raw, 'base64').toString('utf8')
    return {
      name: data.name ?? 'README',
      markdown,
      htmlUrl: data.html_url ?? '',
      truncated: Boolean(data.size && data.size > markdown.length),
    }
  }).catch((error) => { throw asGhViewError(error) })
}

/**
 * Guess the default repository from a directory's git repositories.
 *
 * `upstream` wins over `origin` on purpose: in a fork, `upstream` is the
 * project the user actually wants to read issues and pull requests from.
 *
 * @returns {Promise<string | null>}
 */
export async function detectRepoFromCwd(cwd) {
  const { origin, upstream } = await detectRemotes(cwd)
  return upstream ?? origin ?? null
}
