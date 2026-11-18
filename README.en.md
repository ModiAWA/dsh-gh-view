# gh-view

Look up GitHub repos, issues and pull requests by **`#number`** — from a coding
agent, from a side panel in the DSH window, or from a terminal that has no GUI
at all (in which case you get a **rendered image card**).

![gh-view overview](./gh-view-overview.png)

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) and any other agent terminal that can read files or call a CLI.

---

## What it does

| Surface | What you get |
|---|---|
| **Agent tools** | `gh_repo`, `gh_list`, `gh_view`, `gh_search` — each answers with a PNG card **and** a text summary |
| **Side panel** | A rail on the right edge of the DSH window: type `owner/repo`, then `#123` to open an issue or PR |
| **Image card** | Repository / issue / pull request / list, rendered to PNG for terminals that cannot show HTML |

Everything shares one data layer, so the panel and the agent always agree.

---

## Install

Needs **DeepSeek Harness `^0.2.2-rc.3`** (a `0.2.x` release below `0.3.0`) and
Node.js 22+. The package is a bundle: installing it adds one row.

Install by package name:

- **Plugin Manager** — **Plugins → Add plugin**, target `dsh-gh-view`
- **CLI** — `dsh plugin --profile <profile> add dsh-gh-view`

From a checkout while developing, add the absolute directory instead:

```bash
dsh plugin --profile <profile> add /path/to/dsh-gh-view
```

The bundle's patch inserts that one row:

```yaml
- insert:
    - id: gh-view
      name: dsh-gh-view
      config: {}
```

---

## Agent tools

All four return a card image plus a compact text summary, and all accept
`image: false` to skip rendering.

### `gh_view` — the one you will use most

```
gh_view(ref: "#123", repo?: "owner/repo", kind?: "any" | "issue" | "pr", image?: true)
```

`ref` accepts `#123`, `123`, or `owner/repo#123`. It works out on its own
whether the number is an issue or a pull request.

```
gh_view(ref="#11099", repo="AstrBotDevs/AstrBot")
```

### `gh_repo` — repository overview

```
gh_repo(repo?: "owner/repo", image?: true)
```

`repo` defaults to the repository detected from the workspace, like every
tool. Description, stars, watchers, forks, open issue/PR counts, language,
license, default branch, topics, latest release, last push.

### `gh_list` — lists

```
gh_list(repo?: "owner/repo", kind?: "issue" | "pr" | "any",
        state?: "open" | "closed" | "all", labels?, search?,
        sort?: "created" | "updated", limit?, image?: true)
```

`search` keeps only rows whose title contains those words. `sort` defaults to
`created` — a list ordered by last update puts years-old issues that just got a
comment above genuinely new ones.

### `gh_search` — GitHub search syntax

```
gh_search(query: "repo:owner/name is:open label:bug", limit?, image?: true)
```

### Default repository — follows the workspace

The repository tools accept an explicit `repo`. When you omit it, gh-view reads
the git remotes of the session's working directory and picks one automatically:

- **`upstream` wins over `origin`** — in a fork, `upstream` is the project whose
  issues and pull requests you actually care about.
- If only `origin` exists, that is used.
- If neither is a GitHub remote, the tool says so and asks for `owner/repo`.

So inside a checkout you can just say `gh_view("#42")`.

This is scoped to the directory, never a global setting: two sessions in two
projects resolve to two different repositories.

---

## The GitHub panel

The plugin opens as a **full-screen main panel**: click the **GitHub** row in the
left sidebar (under Plugins and Scheduled tasks) — the whole row, not just the
icon. It is also registered as a right-column tab, so it can sit beside the
conversation while you work.

- **Close** — the panel's **×** returns to the conversation.
- **Back** — inside the panel, **← Back** sits in the tab row where the tabs
  were, which is where the reader's eye already is; it returns to the list you
  came from and the list keeps its filters. Clicking another tab from a detail
  also returns to that list.
- **Refresh** — the panel caches its own reads for 30 seconds; **⟳** drops that
  client cache and asks again (the Host still answers from its 60-second cache,
  so a row that just changed can lag up to a minute).
- **Query block** — the workspace/remote/query block **collapses automatically**
  once a repository is detected (⌄ / ⌃ in the header toggles it), leaving the
  list the height instead of four rows of controls.

### Repository selection

The default scope is **this session's directory**, and the repository is detected
from its git remotes. A workspace remembers the repository you last chose there,
so switching back and forth resumes your choice instead of re-detecting.

### Paging

A list shows 20 rows and a **Load more** control while the last page came back
full — GitHub's lists are far longer than one screen, and a silent truncation
reads as "that's all there is".

### Why lists load in two passes

The per-row badges (checks, review verdict, linked PRs) cost a request or two
per row, which made a 20-row list take five seconds before anything appeared.
The panel therefore asks twice:

1. `badges=0` returns the rows alone (about a second) and the list paints;
2. the full call fills the badges in behind it, merged by issue number so a
   concurrent tab switch cannot be clobbered.

Pull requests normally skip this: a GraphQL list already carries the review
verdict and the check rollup, so the panel makes one list request. When the
`gh` path is unavailable, the REST fallback fills the badges in the second pass
like an issue list.

### Overview

The Overview tab ends with the repository's **README**, rendered with the same
markdown rules as issue bodies.

### What a list row shows

Both lists carry the badges the GitHub web UI puts on a row, so the same glance
answers the same question:

- the **PR / issue glyph**, tinted by state (open, closed, merged, draft)
- **Draft** marker, and **Conflicts** when the branch cannot merge
- **status checks** — the rollup state (passing, failing, running); the detail
  page lists the individual checks and their logs
- **review verdict** — Approved / Changes requested / Review required, using
  GitHub's own `reviewDecision` (which accounts for the branch's required
  reviews, not just a raw approval count)
- **assignees**, review count and comment count
- **linked pull requests** on an issue, with a draft marker

Pull-request pages are fetched in one GraphQL round trip, which is why badges
are already present when the list paints instead of trickling in.

### Detail pages

An issue or pull request detail renders its **markdown body** — and so does every
comment (up to 30). The renderer handles what real GitHub text actually contains:

- headings, lists, task lists (real checkboxes), fenced code, quotes, tables
- inline bold / italic / strike / code / links, plus the HTML GitHub allows
  through (`<strong>`, `<em>`, `<code>`, `<del>`, `<sub>`, `<sup>`, `<kbd>`, `<a>`)
- **GitHub alert callouts** — `> [!IMPORTANT]`, `[!NOTE]`, `[!WARNING]`, … render
  as labelled panels, not as a literal bracketed line
- **`<details>` blocks** stay live and collapsible, which is how bots like
  CodeRabbit fold thousands of generated lines
- **HTML comments are stripped** (CodeRabbit and friends emit machine markers)

Raw HTML is never injected as markup, so a body cannot smuggle in a script or a
style rule. Long bodies and comments start collapsed behind **Show N more lines**
rather than being truncated with an ellipsis.

**Images render.** README badges and screenshots are content, not links:

- `![alt](url)` becomes a real `<img>`, lazy-loaded
- `[![alt](img)](link)` — the badge-shield form — is parsed with a
  bracket-balancing group, so the nested image stays intact instead of being cut
  into `![alt` plus stray punctuation
- raw `<img src="…" width="…">` is honoured, `width` included
- repository-relative paths (`/docs/x.png`, `./x.png`) resolve against
  `raw.githubusercontent.com/<owner>/<repo>/HEAD/`, where `HEAD` is the default
  branch — the same target the GitHub web UI uses for a README image
- a failed fetch falls back to the alt text rather than an empty box

### Status checks

The checks badge is **clickable** and expands into the individual checks, failing
ones first, each linking to its log when GitHub provides a URL. A count alone
only answers "is it green"; the next question is always "which one".

### Filters and order

The Issues and Pull-requests tabs carry GitHub's own query vocabulary, applied
server-side:

- **State** — Open / Closed / All
- **Labels** — comma-separated, all must match (`bug, client: MXU`)
- **Title** — words that must appear in the title (`in:title`)
- **Order** — *Newest created* or *Recently updated*, both newest first. This
  matters: a years-old issue that just got a comment is "recently updated" but
  not new, and the default is creation order so the list reads as a timeline.

### Scope

- **Workspace** — the panel follows the workspace you pick, never a global
  setting.
- **Remote** — when a checkout has both `origin` and `upstream` pointing at
  different repositories, a selector appears so you can switch instead of typing
  either.
- **Jump** — type `#123` (or `owner/repo#123`), press **Jump**

The panel is a pure DOM view using host theme tokens. The PNG card exists for
terminals that cannot render that DOM.

---

## Where the data comes from

Two interchangeable sources, chosen automatically:

1. **`gh` CLI** — if `gh` is installed, gh-view uses it. It inherits the CLI's
   login, so private repositories work and this plugin never sees a token.
2. **Public REST API** — otherwise `api.github.com`, anonymous or with
   `GITHUB_TOKEN` / `GH_TOKEN` if either is set.

If `gh` is installed but cannot answer — signed out, a rejected token, no
network — an automatic read falls back to the REST path instead of failing; the
`gh` diagnostic is reported only when REST fails too.

Anonymous API calls are limited to 60 requests/hour. When that limit is hit the
tool says so and suggests `gh auth login`. Reads are cached in the Host for 60
seconds (remote detection for 10 minutes), so repeated lookups spend no API
calls — but the PNG card is still rasterized per call, about 1–2 seconds. Pass
`image: false` when only the text summary is wanted.

---

## How the image card is produced

The card is authored as HTML and rasterized by a headless Chromium that is
already on the machine — Microsoft Edge or Google Chrome. That keeps CJK
wrapping, font fallback, ellipsis and emoji identical to a browser, and avoids
shipping a font or rasterizer stack inside the plugin.

Consequences worth knowing:

- **A Chromium browser must be installed.** Without one, the tools still answer
  with their text summary and say that rendering was skipped.
- The browser is launched with its own throwaway profile in a temp directory,
  writes the screenshot, and is then terminated by PID (only that process tree).
- The full-window screenshot is cropped to the card's real height by a small
  built-in PNG decoder, so there is no image library dependency.
- Rendering takes about two seconds per card.

If you want to turn rendering off entirely, pass `image: false`; the text
summary carries the same facts.

---

## HTTP routes

The panel talks to the host over these same-origin routes:

| Route | Purpose |
|---|---|
| `GET /gh-view/health` | `{ok, version, build, source, canRender, supportsImageTools, remotes}` |
| `GET /gh-view/remotes?dir=` | GitHub remotes of one directory: `{ok, data: {origin, upstream, preferred, remotes}}` |
| `GET /gh-view/repo?repo=` | repository facts (JSON); `dir=` may replace `repo=` |
| `GET /gh-view/readme?repo=` | repository README as markdown, or `null` |
| `GET /gh-view/repo-card?repo=` | repository card (PNG) |
| `GET /gh-view/view?repo=&ref=` | one issue/PR (JSON) |
| `GET /gh-view/view-card?repo=&ref=` | one issue/PR card (PNG) |
| `GET /gh-view/list?repo=&kind=&state=&labels=&search=&sort=&limit=&offset=&badges=0` | list (JSON), one page |
| `GET /gh-view/search?q=&limit=` | search (JSON) |

`badges=0` returns rows without the per-row checks/review lookups; the panel asks
for that page first so it can paint, then for the same page with badges.

Every route that takes `repo=` also accepts `dir=<workspace path>` and will
detect the repository from that directory's git remotes (`upstream` first).

---

## Using it outside DSH

The plugin is a DSH bundle, but the data and rendering layers are ordinary ES
modules with no DSH imports:

```js
import { getRepo, getPull, getAnyRef } from 'dsh-gh-view/lib/github.js'
import { renderCard } from 'dsh-gh-view/lib/render.js'
import { writeFileSync } from 'node:fs'

const pull = await getAnyRef('AstrBotDevs/AstrBot', 11099)
const { png } = await renderCard(pull)
writeFileSync('card.png', png)
```

The package exports `./lib/*` for exactly this. From a plain checkout, swap the
package specifier for the relative path (`./lib/github.js`).

That is the whole path a non-DSH agent terminal needs: call the functions,
write the PNG, hand the picture to the user.

---

## Files

| File | Role |
|---|---|
| `index.js` | Host half: tool registration, `/gh-view/*` routes |
| `client.js` | Client half: side panel and the tool cards |
| `lib/github.js` | Data layer: `gh` CLI and REST, normalization, caching |
| `lib/render.js` | Card HTML, headless-Chromium rasterizer, PNG cropper |
| `lib/http-guard.js` | Origin/Host checks for the panel's HTTP routes |
| `cordis.patch.yml` | Bundle patch |
| `locale/{en,zh}.json` | Display metadata (`meta.title`, `meta.description`) |
| `icon.svg` | Bundle icon, exported as `./icon` |
| `gh-view-overview.png` | This README's overview image; shipped so npm and the Plugin Manager detail page can serve it |
| `tests/` | Node test runner checks: manifest, library behaviour, packed file list |
| `scripts/overview.mjs` | Builds `gh-view-overview.png` (repository only, not in the npm package) |
| `assets/shot-{pr,issue}.png` | Cards embedded by the overview script (repository only) |
| `.github/workflows/ci.yml` | Tests on Node 22 and 24 |
| `CHANGELOG.md` | Release notes |

## A note on plugin activation

The Host half declares
`export const inject = ['tools', 'attachments', 'webServer', 'workspaceRegistry']`.
That is load-bearing: reading those services through `ctx.get()` instead would
race the boot order, because `get()` is strict and answers `undefined` for a
service that is not active yet — the tools and routes would then be skipped
silently on a cold start while still appearing to work after a hot reload.

`workspaceRegistry` is required rather than convenient: the panel's `dir=`
parameter is confined to registered workspaces, and reading it through
`ctx.get()` races the boot the same way. A race there would not fail loudly — it
would silently widen the confinement, which is why the service is declared.

`workingDirectory` is deliberately **not** in that list. It only feeds the
default-repository convenience, so a profile without it still gets the tools
(with an explicit `repo`) instead of losing the plugin.

One subtlety worth recording: `workingDirectory.get()` takes a **Session**, not
an Agent. It reads the session's `workingDirectory` projection, so passing the
Agent silently returns the deployment default — which looks like "remote
detection is broken" rather than a type error. The Host half unwraps
`agent.session` before calling it.

### The client half's dependencies

The Client half declares its own `inject`:

```js
inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']
```

This is the single most important line for the right-column tab. Those two
services are published by the sidebar-right plugin **from inside its own
effect**, so nothing is available at the moment this plugin's `apply` first
runs. Cordis only guarantees ordering for services named in the module-level
`inject`, which is exactly how every shipped right-column plugin does it:

```js
// dsh-client-ui-sidebar-terminal
const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', ...]
```

Reading them with `ctx.get()` at apply time instead answers `undefined`, the tab
type never registers, and the symptom is silent: the tab is simply absent, with
nothing in the console. Neither `ctx.inject` nor polling fixes it — the
declaration is what makes Cordis wait.

A tab type is two registrations, and a type needs **both**:

1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` — declares the
   kind and the start-page capsule's *data*;
2. `ctx.slots.register({ name: 'sidebar.right.tab.guide.entry', key: id }, Card)`
   — supplies the card that *draws* that capsule. Without it the entry is
   dispatched to the owner's generic fallback.

**The card must handle its own click.** That slot's owner props are only
`{ entryId, kind, title, description }` — there is no pick callback, unlike the
owner's internal `EntryBox` which receives `onPick`. A card that just renders
text looks correct and is completely inert. This one opens the tab through
`ctx.sidebarRight.openTab(kind)`, falling back to the full-screen main panel if
the column has no session to open into.

A custom card also **replaces** the shell's entry box rather than nesting inside
it, so it has to draw the capsule itself or it reads as bare text among bordered
rows. The card mirrors the shell's own metrics — 380px wide, 56px minimum
height, `14px 20px` padding, `0.5px` border, `--dsw-alias-bg-layer-1` fill and
`--dsl-guide-entry-radius` — so it sits flush with the shipped entries.

The panel body (`sidebar.right.pane.tab`) and the main-panel entry
(`sidebar.panellist` + `main`) are slots rather than services, so they register
unconditionally and survive even if the column is absent.

---

## Development

```bash
npm test          # manifest, data-layer, docs and packed-file checks
npm run overview  # rebuild gh-view-overview.png (needs Edge or Chrome)
```

`npm test` is what CI runs (Node 22 and 24, `.github/workflows/ci.yml`). The
tests are offline; rendering a real card needs a browser but is not part of them.

---

## Security notes

DSH's Web server dispatches a named route without a cookie, Host or Origin
check, and these routes expose whatever the host's `gh` login can read. The
consequences are handled explicitly:

- **Browser requests are held to this server's origin.** An `Origin` that names
  another host or scheme, a `Sec-Fetch-Site: cross-site` fetch, and a `Host` that
  is neither the bound address nor a loopback spelling are answered with 403.
  That closes cross-site reads and DNS-rebinding pages. The boundary is the
  machine, not the OS user: another process on this machine can still call the
  routes, and so can another local user, because the listener has no
  authentication of its own.
- **Rendering is capped.** At most two headless browsers run at once, because a
  card starts a browser process and the routes take no authentication.
- **The routes are served only on a loopback bind.** They carry whatever the
  host's `gh` login can read, and a request header cannot prove a peer is local,
  so a DSH server bound to a LAN address — or one whose bind cannot be confirmed
  — disables them with 403 (the agent tools keep working) instead of exposing
  private GitHub data to the network. The server binds to `127.0.0.1` by
  default, which is the intended deployment.
- **`dir=` is confined to registered workspaces.** Unconfined, it would report
  the git remotes of any repository on disk, private ones included. The value is
  canonicalised with `realpath` and compared against the workspace registry, so
  `..`, case tricks and a symlink inside a registered path cannot redirect the
  lookup; a registered path that has itself been replaced resolves to its
  current target, which is what that workspace now is. The canonical path is
  re-checked after resolution, a Windows UNC/device path is refused before it
  can trigger a network lookup, and refusals keep one message so the route is
  not a filesystem existence oracle. When the registry is unavailable the route
  **fails closed** rather than falling back to an open read.
- **Repository names are strictly validated.** `owner/repo` accepts only
  alphanumerics, dot, dash and underscore, and rejects a leading `-` or `@` and a
  bare `..`. That closes a real hole: `gh -F name=@path` reads a file and sends
  its contents as the value, so an unvalidated "repository name" of
  `@C:\…\id_rsa` would exfiltrate it. The same validation also stops `..` from
  retargeting `/repos/../user` at another API endpoint. A leading `.` is
  deliberately allowed — `.github` is one of the most common repository names on
  GitHub.

Bodies are rendered through React elements, never `innerHTML`, and every `href`
and `src` passes a scheme allowlist (`http`, `https`, `mailto`, `#`,
`data:image/*`), so a hostile `[x](javascript:…)` in an issue body produces no
link. Card HTML is escaped before it reaches the headless browser, which loads it
from a `file://` origin where a live `<script>` would be able to read local files.

Paths handed to the API are checked by segment rather than by substring: the URL
parser also collapses `%2e%2e` and treats `\` as `/` under a special scheme, so
`/repos/%2e%2e/user` would otherwise reach `/user` with no literal `..` to find.
The TTL cache is bounded (200 entries, per-entry deadlines) because the routes
can mint a key per query string.

---

## Requirements

- DeepSeek Harness **`^0.2.2-rc.3`** — a `0.2.x` release from `rc.3` up to
  `<0.3.0` (declared as `engines.dsh`; an incompatible DSH refuses the install)
- Node.js **22+** (declared as `engines.node`)
- A profile with `webServer`, `tools`, `attachments` and `workspaceRegistry`
  (the Web profile ships them)
- `gh` CLI *or* network access to `api.github.com`
- Microsoft Edge or Google Chrome, for image cards only

---

## Licence

MIT.
