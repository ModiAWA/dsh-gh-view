/**
 * gh-view: GitHub issue and pull-request viewing for coding agents.
 *
 * Two faces over one data layer:
 *   - agent tools (`gh_repo`, `gh_list`, `gh_view`, `gh_search`) that answer
 *     with a rendered PNG card plus a compact text summary;
 *   - the `/gh-view/*` routes the side panel uses for the same views.
 *
 * The panel never needs a second implementation: both faces call the same
 * functions in `lib/github.js` and `lib/render.js`.
 */

import { readFileSync, promises as fs } from 'node:fs'

import { detectRemotes, getAnyRef, getIssue, getPull, getReadme, getRepo, listItems, parseRef, searchItems, normalizeRepo, GhViewError } from './lib/github.js'
import { assertPanelRequestOrigin } from './lib/http-guard.js'
import { renderCard, findBrowser } from './lib/render.js'

export const name = 'gh-view'

/**
 * Declared dependencies, so Cordis activates this plugin only once these
 * services are live.
 *
 * Reading them with `ctx.get()` instead would be a race: `get()` is strict by
 * default and answers `undefined` for a service whose fiber is not active yet,
 * so on a cold start the tools and routes would be skipped silently. A hot
 * reload hides that, which is exactly why this is declared.
 *
 * `workspaceRegistry` is load-bearing rather than a convenience: the panel's
 * `dir=` parameter is confined to registered workspaces, and reading it through
 * `ctx.get()` races the boot the same way. A race there would silently degrade
 * the confinement, so it is declared and treated as required.
 *
 * `workingDirectory` is deliberately NOT listed: it is only needed to resolve a
 * default repository from git remotes, so a profile without it should still get
 * the tools (with explicit `repo`) instead of losing the plugin entirely.
 */
export const inject = ['tools', 'attachments', 'webServer', 'workspaceRegistry']

const ROUTE_PREFIX = '/gh-view'

/** Code-generation marker reported by `/gh-view/health`. */
const BUILD = 'image-tools-2'

/** Package version, read from the manifest so a release cannot drift from it. */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/** Coerce a value into a JSON-safe snapshot for a tool result. */
function json(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** A one-line, model-facing summary of a rendered view. */
function summaryOf(payload) {
  if (payload.kind === 'repo') {
    return `${payload.fullName}: ${payload.description || '(no description)'} · ★ ${payload.stars} · forks ${payload.forks} · open issues ${payload.openIssues ?? '?'} · open PRs ${payload.openPulls ?? '?'} · ${payload.language || 'n/a'} · ${payload.url}`
  }
  if (payload.kind === 'issue') {
    return `${payload.repo}#${payload.number} ${payload.title} [${payload.state}] by ${payload.author.login} · ${payload.comments} comments · labels: ${payload.labels.map((l) => l.name).join(', ') || 'none'} · ${payload.url}`
  }
  if (payload.kind === 'pr') {
    const checks = payload.checks
    return `${payload.repo}#${payload.number} ${payload.title} [${payload.state}] by ${payload.author.login} · +${payload.additions}/-${payload.deletions} in ${payload.changedFiles} files · checks ${checks.state} · ${payload.approvals.length} approved · ${payload.url}`
  }
  if (payload.kind === 'search') {
    return `${payload.total} matches for "${payload.query}" (${payload.items.length} shown)`
  }
  const items = payload.items ?? []
  return `${items.length} ${payload.kind === 'list-pr' ? 'pull requests' : payload.kind === 'list-issue' ? 'issues' : 'items'} in ${payload.repo}: ` +
    items.slice(0, 8).map((item) => `#${item.number} ${item.title}`).join(' | ')
}

/**
 * Save PNG bytes as a durable attachment and return its reference.
 *
 * The reference travels in the tool's returned value so `output.render` can
 * emit a real `{type:'image'}` block — that is what puts the picture in the
 * conversation for both the model and the Web UI card.
 */
async function imageRef(attachments, png, name) {
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name })
  return json(ref)
}

/**
 * Render one payload to a PNG, or explain why it could not.
 * @returns {Promise<{png?: Buffer, note?: string}>}
 */
async function tryRender(payload) {
  try {
    return await renderCard(payload, {})
  } catch (error) {
    return { note: `Image rendering was skipped: ${error?.message ?? error}` }
  }
}

/**
 * Build the tool result: the image reference rides in the value so the shared
 * `output.render` can emit the image block, and the text summary is what the
 * model reads back.
 */
async function viewResult(attachments, payload, extraText) {
  const { png, note } = await tryRender(payload)
  const summary = summaryOf(payload)
  const image = png === undefined ? undefined : await imageRef(attachments, png, `gh-view-${payload.kind}.png`)
  return {
    ok: true,
    kind: payload.kind,
    summary,
    rendered: image !== undefined,
    ...(image === undefined ? {} : { image }),
    ...(note === undefined ? {} : { note }),
    ...(extraText === undefined ? {} : { detail: extraText }),
    value: json(payload),
  }
}

/**
 * The shared `output.render`: one text block the model can quote, then the
 * card image. A tool that did not render still answers with its summary.
 */
function renderToolOutput(_args, value) {
  const text = [value?.summary, value?.detail, value?.note].filter(Boolean).join('\n')
  const blocks = [{ type: 'text', text: text || 'No result.' }]
  if (value?.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/**
 * Model-facing output schema.
 *
 * The tool pipeline validates the returned value against this, and the schema
 * DSL rejects a top-level `required` array, so every field is optional here and
 * the required ones are enforced by the implementation.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    kind: { type: 'string' },
    summary: { type: 'string' },
    detail: { type: 'string' },
    note: { type: 'string' },
    rendered: { type: 'boolean' },
    image: {
      type: 'object',
      additionalProperties: true,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
    },
    value: { type: 'object', additionalProperties: true },
  },
}

/** The one output definition every gh-view tool shares. */
const OUTPUT = { schema: OUTPUT_SCHEMA, render: renderToolOutput }

/** Shared schema fragment for a repository argument. */
const repoParam = {
  type: 'string',
  description:
    'Repository as owner/repo. Omit to use the working directory’ git remote, preferring upstream over origin.',
}

/** Shared schema fragment for a reference argument. */
const refParam = {
  type: 'string',
  description: 'Issue or pull request as #123, 123, or owner/repo#123.',
}

export function apply(ctx) {
  // These are declared in `inject`, so they are live by the time apply runs.
  const tools = ctx.tools
  const attachments = ctx.attachments
  const webServer = ctx.webServer
  // Optional: only feeds the default-repository convenience, never a hard need.
  const workingDirectory = ctx.get('workingDirectory')
  const disposers = []

  /**
   * Resolve the repository for one agent call: explicit, then the agent's
   * working directory remotes (`upstream` before `origin`, because in a fork
   * `upstream` is the project whose issues and pull requests matter).
   */
  const resolveRepo = async (agent, explicit) => {
    const named = normalizeRepo(explicit)
    if (named !== undefined) return named
    const directory = workingDirectory !== undefined && agent !== undefined
      ? safeWorkingDirectory(workingDirectory, agent)
      : undefined
    const { origin, upstream } = await detectRemotes(directory)
    const detected = upstream ?? origin
    if (detected !== null && detected.includes('/')) return detected
    throw new GhViewError(
      'No repository given, and none could be detected from the working directory’ git remotes. Pass repo as owner/repo.',
      'GH_VIEW_NO_REPO',
    )
  }

  {
    disposers.push(
      tools.register(
        {
          name: 'gh_repo',
          description:
            'Show a GitHub repository overview: description, stars, watchers, forks, open issue/PR counts, language, license, topics and latest release. Returns a rendered card image plus a text summary.',
          parameters: {
            type: 'object',
            properties: { repo: repoParam, image: { type: 'boolean', description: 'Render the card image. Defaults to true.' } },
            additionalProperties: false,
          },
          output: OUTPUT,
          async execute(args, exec) {
            const repo = await resolveRepo(exec.agent, args?.repo)
            const payload = await getRepo(repo, {})
            const result = args?.image === false
              ? { ok: true, kind: payload.kind, summary: summaryOf(payload), rendered: false, value: json(payload) }
              : await viewResult(attachments, payload)
            return json(result)
          },
        },
        {},
      ),
    )

    disposers.push(
      tools.register(
        {
          name: 'gh_list',
          description:
            'List issues or pull requests in a repository, newest first by creation date unless `sort` says otherwise. Returns a rendered card image plus a text summary.',
          parameters: {
            type: 'object',
            properties: {
              repo: repoParam,
              kind: { type: 'string', enum: ['issue', 'pr', 'any'], description: 'Which rows to list. Defaults to any.' },
              state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Defaults to open.' },
              labels: { type: 'string', description: 'Comma-separated label names that must all be present.' },
              search: { type: 'string', description: 'Words that must appear in the title.' },
              sort: {
                type: 'string',
                enum: ['created', 'updated'],
                description: 'Order rows by creation or last update, newest first. Defaults to created.',
              },
              limit: { type: 'number', description: 'How many rows to return, 1 to 50. Defaults to 15.' },
              image: { type: 'boolean', description: 'Render the card image. Defaults to true.' },
            },
            additionalProperties: false,
          },
          output: OUTPUT,
          async execute(args, exec) {
            const repo = await resolveRepo(exec.agent, args?.repo)
            const payload = await listItems(repo, {
              kind: args?.kind ?? 'any',
              state: args?.state ?? 'open',
              labels: args?.labels,
              search: args?.search,
              sort: args?.sort ?? 'created',
              limit: args?.limit,
            }, {})
            const result = args?.image === false
              ? { ok: true, kind: payload.kind, summary: summaryOf(payload), rendered: false, value: json(payload) }
              : await viewResult(attachments, payload)
            return json(result)
          },
        },
        {},
      ),
    )

    disposers.push(
      tools.register(
        {
          name: 'gh_view',
          description:
            'Show one issue or pull request by number: title, body, author, labels, and for pull requests the change size (+/-), checks, approvals and reviews. Works out which of the two the number refers to. Returns a rendered card image plus a text summary.',
          parameters: {
            type: 'object',
            properties: {
              ref: refParam,
              repo: repoParam,
              kind: { type: 'string', enum: ['any', 'issue', 'pr'], description: 'Force a kind when a number exists as both. Defaults to any.' },
              image: { type: 'boolean', description: 'Render the card image. Defaults to true.' },
            },
            required: ['ref'],
            additionalProperties: false,
          },
          output: OUTPUT,
          async execute(args, exec) {
            const parsed = parseRef(args?.ref)
            const repo = await resolveRepo(exec.agent, args?.repo ?? parsed.repo)
            const number = parsed.number
            const requested = args?.kind ?? 'any'
            let payload
            if (requested === 'issue') payload = await getIssue(repo, number, {})
            else if (requested === 'pr') payload = await getPull(repo, number, {})
            else payload = await getAnyRef(repo, number, {})
            const result = args?.image === false
              ? { ok: true, kind: payload.kind, summary: summaryOf(payload), rendered: false, value: json(payload) }
              : await viewResult(attachments, payload)
            return json(result)
          },
        },
        {},
      ),
    )

    disposers.push(
      tools.register(
        {
          name: 'gh_search',
          description:
            'Search GitHub issues and pull requests. Accepts GitHub search syntax, for example "repo:owner/name is:open label:bug" or "deepseek harness in:title". Returns a rendered card image plus a text summary.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'GitHub issue search query.' },
              limit: { type: 'number', description: 'How many rows to return, 1 to 30. Defaults to 10.' },
              image: { type: 'boolean', description: 'Render the card image. Defaults to true.' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          output: OUTPUT,
          async execute(args) {
            const payload = await searchItems(args?.query, { limit: args?.limit })
            const result = args?.image === false
              ? { ok: true, kind: payload.kind, summary: summaryOf(payload), rendered: false, value: json(payload) }
              : await viewResult(attachments, payload)
            return json(result)
          },
        },
        {},
      ),
    )
  }

  // The panel's HTTP face. One route answers every panel request; the action
  // and its parameters travel in the query string.
  {
    disposers.push(
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          try {
            assertLoopbackBind(ctx)
            assertPanelRequestOrigin(ctx, request)
            const url = new URL(request.url ?? '/', 'http://localhost')
            const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
            await handlePanelRequest(ctx, action, url, request, response)
          } catch (error) {
            const code = error instanceof GhViewError ? error.code : undefined
            if (code === 'GH_VIEW_BAD_ORIGIN' || code === 'GH_VIEW_BAD_HOST' || code === 'GH_VIEW_REMOTE_BIND') {
              sendJson(response, 403, { ok: false, error: error.message, code })
              return
            }
            const status = code === 'GH_VIEW_NOT_FOUND' ? 404 : 400
            sendJson(response, status, { ok: false, error: error?.message ?? String(error), code })
          }
        },
      }),
    )
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // each registration is independent; keep unloading the rest
      }
    }
  }, 'gh-view: routes and tools')

  // A quiet startup note that names the data source and whether cards can render.
  void (async () => {
    try {
      const browser = await findBrowser()
      const gh = await import('./lib/github.js').then((module) => module.ghAvailable())
      ctx.logger?.info?.(
        `gh-view ready: data via ${(await gh) ? 'gh CLI' : 'public REST API'}, image cards ${browser ? 'on' : 'off (no Chromium browser found)'}`,
      )
    } catch {
      // diagnostics only
    }
  })()
}

/**
 * Read one agent's working directory without letting a lookup failure escape.
 *
 * The service's contract is `get(session)`, not `get(agent)`: it reads the
 * session's `workingDirectory` projection. Passing the Agent itself silently
 * yields the deployment default, which zeroes out remote detection, so the
 * session is unwrapped first.
 */
function safeWorkingDirectory(service, agent) {
  try {
    const session = agent?.session ?? agent
    if (session === undefined) return undefined
    return service.get(session) ?? undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response. */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Confine a `dir=` parameter to the directories the user has registered as
 * workspaces.
 *
 * Returns the canonical path when it is one of them, otherwise `undefined` — and
 * an absent directory is not an error: it simply means "no repository can be
 * detected from here", which is the state the panel already renders as an empty
 * picker.
 *
 * Matching is done on the canonical spelling from `fs.realpath`, so a symlink, a
 * `..` segment or a differently-cased Windows path cannot escape the set. The
 * workspace registry canonicalizes on creation, but a path is re-resolved here
 * because the caller supplies the spelling.
 */
async function resolveConfinedDir(ctx, requested) {
  if (requested === null || requested === undefined || requested === '') return undefined
  // A Windows UNC or device path makes `realpath` start an SMB lookup with the
  // host's credentials, so refuse the shape before any filesystem call. Nothing
  // the workspace registry holds can be one.
  if (process.platform === 'win32' && /^[\\/]{2}/.test(requested)) {
    throw new GhViewError('Directory lookups are limited to the registered workspaces.', 'GH_VIEW_DIR_NOT_ALLOWED')
  }
  const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry')
  if (registry === undefined || registry === null) {
    // No registry to check against. Refuse rather than fall back to an
    // unconfined read: the routes are reachable by any local process, so an
    // unchecked `dir=` would report the git remotes of any repository on disk.
    // Tools pass an explicit `repo` and do not need this path.
    throw new GhViewError(
      'Directory lookups are unavailable: the workspace registry is not active.',
      'GH_VIEW_NO_REGISTRY',
    )
  }
  try {
    const workspaces = registry.list()
    const allowed = new Set()
    for (const workspace of workspaces ?? []) {
      allowed.add(normalizeDirKey(workspace.path))
      try {
        allowed.add(normalizeDirKey(await fs.realpath(workspace.path)))
      } catch {
        // A workspace whose directory vanished stays matchable by its spelling.
      }
    }
    if (allowed.size === 0) {
      throw new GhViewError(
        'Directory lookups are limited to registered workspaces, and none are registered.',
        'GH_VIEW_DIR_NOT_ALLOWED',
      )
    }
    const direct = normalizeDirKey(requested)
    if (allowed.has(direct)) {
      // Prefer the canonical form so `git -C` and the cache key agree. A failed
      // resolution refuses rather than passing the unchecked spelling on: one
      // filesystem state must not decide the answer and another receive it.
      let canonical
      try {
        canonical = await fs.realpath(requested)
      } catch {
        throw new GhViewError('Directory lookups are limited to the registered workspaces.', 'GH_VIEW_DIR_NOT_ALLOWED')
      }
      // Re-check after resolution: a workspace path replaced by a symlink since
      // the registry was read must not turn into a lookup outside the set.
      if (allowed.has(normalizeDirKey(canonical))) return canonical
    }
    let canonical
    let resolved
    try {
      resolved = await fs.realpath(requested)
      canonical = normalizeDirKey(resolved)
    } catch {
      // Same refusal as a well-formed non-member: telling "no such path" apart
      // from "not allowed" would give an unauthenticated caller a filesystem
      // existence oracle.
      throw new GhViewError('Directory lookups are limited to the registered workspaces.', 'GH_VIEW_DIR_NOT_ALLOWED')
    }
    // Return the real path, not the comparison key: the key is lowercased and
    // separator-normalized, and handing that back would give `git -C` and the
    // cache a different spelling of the same directory than the canonical one.
    if (allowed.has(canonical)) return resolved
    throw new GhViewError(
      'Directory lookups are limited to the registered workspaces.',
      'GH_VIEW_DIR_NOT_ALLOWED',
    )
  } catch (error) {
    if (error instanceof GhViewError) throw error
    throw new GhViewError(`Cannot check that directory: ${error.message}`, 'GH_VIEW_DIR_NOT_ALLOWED')
  }
}

/**
 * Serve the panel routes only when the Web server is bound to loopback.
 *
 * The routes carry whatever the host's GitHub login can read, and any peer that
 * can route to a LAN-bound server can call them; a request header cannot prove
 * locality. Binding to loopback is the default, so a deployment that chooses to
 * expose DSH beyond it deliberately gives up these routes rather than leaking
 * the host's GitHub access.
 */
function assertLoopbackBind(ctx) {
  let hostname
  try {
    hostname = new URL(ctx.webServer.getOrigin()).hostname.toLowerCase()
  } catch {
    // Cannot establish the bind: refuse rather than promise a boundary the
    // server may not have. The agent tools keep working.
    throw new GhViewError(
      'gh-view routes are disabled because the DSH server bind cannot be confirmed as loopback.',
      'GH_VIEW_REMOTE_BIND',
    )
  }
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  if (!loopback) {
    throw new GhViewError(
      'gh-view routes are disabled because the DSH server is bound beyond loopback; bind it to 127.0.0.1 to use the panel.',
      'GH_VIEW_REMOTE_BIND',
    )
  }
}

/** Compare directory spellings the way the platform does. */
function normalizeDirKey(value) {
  const text = String(value ?? '')
  // Windows paths are case-insensitive and tolerate either separator. A
  // backslash is an ordinary filename character on POSIX, so it is only
  // stripped as a separator on Windows.
  if (process.platform === 'win32') {
    return text.toLowerCase().replace(/\//g, '\\').replace(/[\\/]+$/, '')
  }
  return text.replace(/\/+$/, '')
}

/**
 * The panel's request dispatcher.
 *
 * Actions:
 *   `health`             -> browser/source capability report
 *   `remotes?dir=`       -> GitHub remotes of one registered workspace directory
 *   `repo?repo=`         -> repository overview (JSON)
 *   `readme?repo=`       -> repository README (markdown, or null)
 *   `repo-card?repo=`    -> repository overview card (PNG)
 *   `view?repo=&ref=`    -> one issue/PR (JSON)
 *   `view-card?repo=&ref=` -> one issue/PR card (PNG)
 *   `list?repo=&kind=&state=&labels=&search=&sort=&limit=&offset=&badges=0`
 *   `search?q=&limit=`
 */
async function handlePanelRequest(ctx, action, url, request, response) {
  const params = url.searchParams
  const repoArg = params.get('repo') ?? undefined

  /**
   * The directory this panel request is about.
   *
   * The panel is a root-scoped surface, so it has no Session of its own; it
   * names the directory it is viewing (`dir=`) and the plugin detects remotes
   * there. That is what makes the default follow the workspace instead of a
   * global setting.
   *
   * The value is confined to directories the user has actually registered as
   * workspaces. The Web server binds to loopback but performs no cookie, Host or
   * Origin check before dispatch (its own documentation states as much), so any
   * local process — or any page the browser loads — can call these routes. Left
   * unconfined, `dir=C:\Users\...` would report the git remotes of an arbitrary
   * repository on the machine, private ones included. Confinement keeps the
   * feature (each workspace resolves its own remotes) without turning the route
   * into a filesystem probe.
   *
   * Resolved lazily and memoized: most actions never look at `dir`, and a
   * request that carries an irrelevant one should not fail on it.
   */
  let directoryResolved = false
  let directoryArg
  const resolveDirectory = async () => {
    if (!directoryResolved) {
      directoryResolved = true
      directoryArg = await resolveConfinedDir(ctx, params.get('dir'))
    }
    return directoryArg
  }

  const resolveRepo = async (explicit) => {
    // An explicit `owner/repo#123` reference carries its own repository and must
    // win over the panel's currently selected one — that is what makes Jump work
    // across repositories.
    const override = normalizeRepo(explicit)
    if (override !== undefined) return override
    const named = normalizeRepo(repoArg)
    if (named !== undefined) return named
    const { origin, upstream } = await detectRemotes(await resolveDirectory())
    const detected = upstream ?? origin
    if (detected !== null && detected.includes('/')) return detected
    throw new GhViewError(
      'No repository. Pass repo=owner/repo, or dir=<workspace path> so its git remotes can be detected.',
      'GH_VIEW_NO_REPO',
    )
  }

  if (action === '' || action === 'health') {
    const browser = await findBrowser()
    const { ghAvailable } = await import('./lib/github.js')
    // `build` lets a caller tell apart code generations after a reload.
    sendJson(response, 200, {
      ok: true,
      version: VERSION,
      build: BUILD,
      source: (await ghAvailable()) ? 'gh' : 'api',
      canRender: browser !== undefined,
      supportsImageTools: true,
      remotes: true,
    })
    return
  }

  // Which GitHub repositories this workspace's git remotes point at, so the
  // panel can default to one and offer a choice when origin and upstream
  // disagree.
  if (action === 'remotes') {
    const dirArg = await resolveDirectory()
    const { origin, upstream, remotes } = await detectRemotes(dirArg)
    sendJson(response, 200, {
      ok: true,
      data: {
        dir: dirArg ?? null,
        origin,
        upstream,
        // `upstream` is the better default in a fork, so the preference is
        // stated explicitly rather than left to the client.
        preferred: upstream ?? origin ?? null,
        remotes,
      },
    })
    return
  }

  if (action === 'repo') {
    const repo = await resolveRepo()
    sendJson(response, 200, { ok: true, data: json(await getRepo(repo, {})) })
    return
  }

  // The repository's README, for the Overview page. A repository without one
  // answers `null`, which the panel renders as its own empty state.
  if (action === 'readme') {
    const repo = await resolveRepo()
    sendJson(response, 200, { ok: true, data: json(await getReadme(repo, {})) })
    return
  }

  if (action === 'repo-card') {
    const repo = await resolveRepo()
    const payload = await getRepo(repo, {})
    const { png } = await renderCard(payload, {})
    sendPng(response, png)
    return
  }

  if (action === 'view') {
    const parsed = parseRef(params.get('ref'))
    const repo = await resolveRepo(parsed.repo)
    const kind = params.get('kind') ?? 'any'
    const payload = kind === 'issue'
      ? await getIssue(repo, parsed.number, {})
      : kind === 'pr'
        ? await getPull(repo, parsed.number, {})
        : await getAnyRef(repo, parsed.number, {})
    sendJson(response, 200, { ok: true, data: json(payload) })
    return
  }

  if (action === 'view-card') {
    const parsed = parseRef(params.get('ref'))
    const repo = await resolveRepo(parsed.repo)
    const kind = params.get('kind') ?? 'any'
    const payload = kind === 'issue'
      ? await getIssue(repo, parsed.number, {})
      : kind === 'pr'
        ? await getPull(repo, parsed.number, {})
        : await getAnyRef(repo, parsed.number, {})
    const { png } = await renderCard(payload, {})
    sendPng(response, png)
    return
  }

  if (action === 'list') {
    const repo = await resolveRepo()
    const payload = await listItems(repo, {
      kind: params.get('kind') ?? 'any',
      state: params.get('state') ?? 'open',
      labels: params.get('labels') ?? undefined,
      search: params.get('search') ?? undefined,
      sort: params.get('sort') ?? undefined,
      offset: params.get('offset') ?? undefined,
      // `badges=0` returns the rows without the per-row lookups, so the list
      // paints immediately; the panel fetches them separately.
      badges: params.get('badges') === '0' ? false : undefined,
      limit: params.get('limit') ?? undefined,
    }, {})
    sendJson(response, 200, { ok: true, data: json(payload) })
    return
  }

  if (action === 'search') {
    const payload = await searchItems(params.get('q') ?? '', { limit: params.get('limit') ?? undefined })
    sendJson(response, 200, { ok: true, data: json(payload) })
    return
  }

  sendJson(response, 404, { ok: false, error: `Unknown gh-view action "${action}".` })
}

/** Write one PNG response. */
function sendPng(response, png) {
  response.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'content-length': png.length,
  })
  response.end(png)
}
