# Changelog

Notable changes to `dsh-gh-view`. Releases follow semantic versioning.

## 1.0.1 — 2026-11-19

Documentation only.

- README is now a Chinese usage manual; the previous English README is kept as
  `README.en.md`.
- Implementation and security design notes moved to `docs/IMPLEMENTATION.md`.

## 1.0.0 — 2026-11-19

First release.

### Added

- DSH bundle with a full-screen **GitHub** panel, a right-column tab, and four
  agent tools: `gh_repo`, `gh_list`, `gh_view`, `gh_search`.
- PNG cards for terminals without a GUI, rasterized by the Edge or Chrome
  already installed on the machine and cropped by a built-in PNG decoder — no
  image library or bundled font stack.
- Default repository detection from the workspace's git remotes (`upstream`
  before `origin`), a remote selector, and a `#123` jump box.
- Issue and pull-request pages that render markdown bodies and comments,
  including GitHub alert callouts, collapsible `<details>` blocks, images and
  badge-shield links; raw HTML is never injected as markup.
- List filters using GitHub's query vocabulary (state, labels, `in:title`) and
  both orderings (created, updated), with paging.
- Pull-request lists fetched in one GraphQL round trip; badge-less first paint
  followed by the check/review pass. Closed lists include merged PRs, and deep
  pages walk GraphQL cursors instead of stopping at 100 rows.
- Status-check badges that expand into the individual checks, failing first, each
  linking to its log when GitHub provides one (including legacy commit statuses).
- Issue and pull-request pages keep GitHub's own state flags: a closed but
  unmerged PR is not reported as merged.
- Two interchangeable data sources with automatic fallback: the `gh` CLI
  (private repositories, no token handled here) and the public REST API
  (`GITHUB_TOKEN` / `GH_TOKEN` supported); an installed-but-unusable `gh` falls
  back to REST instead of failing the read.
- `dir=` handling confined to registered workspaces, and strict `owner/repo`
  validation that also blocks `gh -F name=@path` argument injection.
- The HTTP routes check Origin, `Sec-Fetch-Site` and Host, are served only when
  the DSH server is bound to loopback, and cap card rendering at two concurrent
  headless browsers.
- `engines.dsh` (`^0.2.2-rc.3`) and `engines.node` (`>=22`) declarations, so an
  incompatible DSH refuses the install instead of failing at runtime.
- Tests for the manifest, the packed file list, the data layer, the release
  docs, the HTTP guard and the review regressions; CI runs them on Node 22 and
  24.

### Notes

- Requires DeepSeek Harness `^0.2.2-rc.3` (a `0.2.x` release below `0.3.0`) and
  Node.js 22+.
- Image cards need Microsoft Edge or Google Chrome; pass `image: false` for
  text-only answers.
