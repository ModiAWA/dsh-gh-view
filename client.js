/**
 * The gh-view side panel.
 *
 * A convenience rail anchored to the right edge of the window. It is a normal
 * React tree inside the host's overlay slot, so it inherits the host theme,
 * fonts and focus behaviour. Everything it shows comes from `/gh-view/*` on the
 * same origin, which the Host half registers — one data path, shared with the
 * agent tools.
 *
 * Entering `#123` (or `owner/repo#123`) resolves the reference and opens the
 * issue or pull request, so the panel is a lookup box as much as a browser.
 */

window.__ModuleLoader__.load({
  id: 'dsh-gh-view',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const ROUTE = '/gh-view'
    const PANEL_ID = 'gh-view-panel'
    /** Tab-type kind for the right column page; also the registration id. */
    const TAB_KIND = 'gh-view'
    /** Rows per list page. A full page means "there may be more". */
    const PAGE_SIZE = 20

    /**
     * The right column's navigation face, captured at apply time.
     *
     * The sidebar entry calls `openTab`, and the page's own close control calls
     * `close`, so open/closed stays shell-owned exactly like every other tab in
     * that column.
     */
    const sidebarRightRef = { current: undefined }

    /**
     * The frame's layout service, captured at apply time.
     *
     * As a main panel the surface has no close affordance of its own, so its
     * header's × calls `selectPanel(null)` to show the Conversation again.
     */
    const layoutRef = { current: undefined }

    /**
     * A short-lived response cache for reads.
     *
     * Switching tabs, reopening a detail and switching a workspace back all ask
     * for data the panel just had. The Host half caches too, but that still pays
     * a round trip plus JSON decode; this keeps the previous answer for a few
     * seconds so a tab flip paints immediately. Writes and anything that must be
     * fresh bypass it.
     */
    const readCache = new Map()
    const READ_TTL_MS = 30_000

    /** Drop every cached read, after something that changes what a read returns. */
    function invalidateReads() {
      readCache.clear()
    }

    /** Ask the Host half for one action. */
    async function call(action, params) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        // Empty string is a real value here, not "absent": `dir=''` means "this
        // session's directory". Dropping it made the Host fall back to its own
        // default, so the picker's first option answered with no remotes at all
        // and looked unresponsive.
        if (value !== undefined && value !== null) query.set(key, String(value))
      }
      const suffix = query.size > 0 ? `?${query}` : ''
      const key = `${action}${suffix}`
      const now = Date.now()
      const hit = readCache.get(key)
      if (hit !== undefined && now - hit.at < READ_TTL_MS) return hit.value
      const response = await fetch(`${ROUTE}/${action}${suffix}`, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `Request failed (HTTP ${response.status}).`)
      }
      // A route that answers without a `data` field (health) returns the body
      // itself; `data: null` is a real answer (a repository with no README), so
      // it must not be replaced by the envelope.
      const value = Object.hasOwn(body, 'data') ? body.data : body
      readCache.set(key, { at: now, value })
      return value
    }

    /** Compact a count: 46770 -> 46.8k. */
    function compact(number) {
      const n = Number(number)
      if (!Number.isFinite(n)) return '0'
      if (Math.abs(n) < 1000) return String(n)
      if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
      return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
    }

    /** Whole days between a timestamp and now, as a short human string. */
    function ago(iso) {
      if (!iso) return ''
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const days = Math.floor((Date.now() - then) / 86_400_000)
      if (days < 1) return 'today'
      if (days < 30) return `${days}d ago`
      const months = Math.floor(days / 30)
      if (months < 12) return `${months}mo ago`
      return `${Math.floor(months / 12)}y ago`
    }

    /** Styles are scoped under the panel root and use only host theme tokens. */
    const STYLES = `
      /*
       * The page fills its host: a main panel's column is wide, so the same
       * markup reads as a full page here and as a narrow column in the right
       * tab. Nothing is position:fixed.
       */
      .ghv-main {
        height: 100%; min-height: 0; width: 100%;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font: inherit;
      }
      .ghv-page {
        display: flex; flex-direction: column;
        height: 100%; min-height: 0; width: 100%;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px;
      }
      /* A main panel is wide: keep the reading column from stretching. */
      .ghv-main .ghv-page > * { max-width: 980px; width: 100%; margin-left: auto; margin-right: auto; }
      .ghv-main .ghv-body { max-width: 980px; }
      /* The sidebar row itself is shell-owned; only the glyph is ours. */
      .ghv-back {
        display: inline-flex; align-items: center; gap: 4px;
        font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
        padding: 4px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
      }
      .ghv-back:hover { background: var(--dsw-alias-bg-layer-2); }
      .ghv-filters {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 6px;
        padding: 0 12px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      /* The column is narrow: state pairs with Apply, the two text fields share a row. */
      .ghv-filter-state { min-width: 0; }
      .ghv-head {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-specific-sidebar-fill);
      }
      .ghv-title { font-weight: 650; font-size: 13px; flex: none; }
      .ghv-spacer { flex: 1; }
      .ghv-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 7px; cursor: pointer;
        background: transparent; border: 0; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 15px; line-height: 1;
      }
      .ghv-icon:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ghv-icon[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ghv-search { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .ghv-row { display: flex; gap: 6px; }
      .ghv-input {
        flex: 1; min-width: 0; font: inherit; font-size: 12.5px; padding: 6px 9px;
        border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        outline: none;
      }
      .ghv-input:focus { border-color: var(--dsw-alias-brand-primary); }
      .ghv-input::placeholder { color: var(--dsw-alias-label-secondary); }
      .ghv-select { appearance: auto; cursor: pointer; padding-right: 6px; }
      .ghv-src {
        font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
        color: var(--dsw-alias-label-secondary); align-self: center; flex: none;
        padding: 0 2px;
      }
      .ghv-btn {
        font: inherit; font-size: 12px; padding: 6px 11px; border-radius: 7px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); white-space: nowrap;
      }
      .ghv-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      /*
       * Emphasis buttons use the brand accent as a BORDER and the raised surface
       * as fill, never brand-as-fill with white text: the theme's brand token can
       * resolve to near-white in the light theme, which produced a blank-looking
       * button. Ink stays a label token, so contrast holds in both themes.
       */
      .ghv-btn-primary {
        background: var(--dsw-alias-brand-primary);
        border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-bg-base);
        font-weight: 650;
      }
      .ghv-btn-primary:hover { filter: brightness(0.94); }
      .ghv-btn:disabled { opacity: .55; cursor: default; }
      .ghv-tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
      /* Collapsed query header: one line with the repo, its source and the jump box. */
      .ghv-current {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .ghv-current-repo { font-size: 12.5px; font-weight: 600; }
      /* Detail-view crumb beside the Back button. */
      .ghv-tab-crumb { font-size: 12px; color: var(--dsw-alias-label-secondary); align-self: center; }
      /* "Load more" sits under the list, centred, with its own breathing room. */
      .ghv-more-row {
        display: flex; justify-content: center; padding: 10px 12px 14px;
        border-top: 1px solid var(--dsw-alias-border-l1);
      }
      .ghv-loading-inline {
        display: flex; align-items: center; gap: 6px;
        font-size: 11.5px; color: var(--dsw-alias-label-secondary); padding: 4px 0;
      }
      .ghv-jump-compact { width: 210px; min-width: 150px; }
      .ghv-jump-compact .ghv-input { width: 100%; }
      .ghv-jump-compact .ghv-row { gap: 4px; }
      .ghv-tab {
        font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
        border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
      }
      .ghv-tab:hover { background: var(--dsw-alias-bg-layer-2); }
      .ghv-tab[aria-selected="true"] {
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        border-color: var(--dsw-alias-border-l1); font-weight: 600;
      }
      .ghv-body { flex: 1; overflow: auto; padding: 12px; }
      .ghv-section { margin-bottom: 14px; }
      .ghv-label {
        font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
        color: var(--dsw-alias-label-secondary); margin-bottom: 5px;
      }
      .ghv-h1 { font-size: 15px; font-weight: 650; line-height: 1.35; margin: 0 0 6px; word-break: break-word; }
      .ghv-h1 .ghv-num { color: var(--dsw-alias-label-secondary); font-weight: 600; }
      .ghv-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .ghv-box {
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 9px 11px; font-size: 12.5px; line-height: 1.55;
        white-space: pre-wrap; word-break: break-word;
      }
      .ghv-box-empty { color: var(--dsw-alias-label-secondary); }
      /* Rendered markdown body. */
      .ghv-md {
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 10px 12px; font-size: 12.5px; line-height: 1.6;
        word-break: break-word; overflow-wrap: anywhere;
      }
      .ghv-md-p { margin: 0; white-space: pre-wrap; }
      .ghv-md-gap { height: 8px; }
      /* Images in a body: badges sit inline, screenshots stay within the column. */
      .ghv-md-img { border: 0; }
      .ghv-md-figure { margin: 6px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .ghv-md-figure .ghv-md-img { max-height: 320px; object-fit: contain; }
      .ghv-md .ghv-md-img:not(.ghv-md-figure .ghv-md-img) { max-width: 100%; }
      .ghv-md-li { margin: 1px 0; padding-left: 2px; white-space: pre-wrap; }
      .ghv-md-h { font-weight: 650; margin: 8px 0 3px; }
      .ghv-md-h1 { font-size: 14px; }
      .ghv-md-h2 { font-size: 13.5px; }
      .ghv-md-h3, .ghv-md-h4, .ghv-md-h5, .ghv-md-h6 { font-size: 13px; }
      .ghv-md > .ghv-md-h:first-child { margin-top: 0; }
      .ghv-inline-code {
        font-family: var(--ds-font-family-code, Consolas, monospace); font-size: 11.5px;
        background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 0 4px;
      }
      .ghv-code {
        margin: 6px 0; padding: 8px 10px; border-radius: 7px; overflow-x: auto;
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
        font-family: var(--ds-font-family-code, Consolas, monospace);
        font-size: 11.5px; line-height: 1.5; white-space: pre;
      }
      .ghv-quote {
        margin: 5px 0; padding: 2px 0 2px 9px;
        border-left: 2px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); white-space: pre-wrap;
      }
      /* GitHub alert callouts: > [!IMPORTANT] etc. */
      .ghv-alert {
        margin: 8px 0; border-radius: 8px; overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l2);
        border-left-width: 3px;
      }
      .ghv-alert-head {
        padding: 5px 10px 0; font-size: 11.5px; font-weight: 650;
        display: flex; align-items: center; gap: 5px;
      }
      .ghv-alert-title {
        padding: 0 10px; font-size: 13.5px; font-weight: 650; margin-top: 2px;
      }
      .ghv-alert-body { padding: 4px 10px 8px; }
      .ghv-alert-body > .ghv-md-gap:first-child { display: none; }
      .ghv-alert-note { border-left-color: var(--dsw-alias-brand-primary); }
      .ghv-alert-note .ghv-alert-head { color: var(--dsw-alias-brand-primary); }
      .ghv-alert-tip { border-left-color: var(--dsw-alias-state-success-primary); }
      .ghv-alert-tip .ghv-alert-head { color: var(--dsw-alias-state-success-primary); }
      .ghv-alert-important { border-left-color: var(--dsw-alias-brand-primary); }
      .ghv-alert-important .ghv-alert-head { color: var(--dsw-alias-brand-primary); }
      .ghv-alert-warning { border-left-color: var(--dsw-alias-state-warn-primary); }
      .ghv-alert-warning .ghv-alert-head { color: var(--dsw-alias-state-warn-primary); }
      .ghv-alert-caution { border-left-color: var(--dsw-alias-state-error-primary); }
      .ghv-alert-caution .ghv-alert-head { color: var(--dsw-alias-state-error-primary); }
      .ghv-more {
        margin-top: 7px; font: inherit; font-size: 11.5px; cursor: pointer;
        background: transparent; border: 0; padding: 0; color: var(--dsw-alias-brand-primary);
      }
      .ghv-more:hover { text-decoration: underline; }
      /* Block-level markdown pieces. */
      .ghv-md-list { margin: 3px 0; }
      .ghv-md-rule {
        height: 1px; margin: 10px 0; background: var(--dsw-alias-border-l1);
      }
      .ghv-kbd {
        font-family: var(--ds-font-family-code, Consolas, monospace); font-size: 11px;
        padding: 0 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 0 var(--dsw-alias-border-l1);
      }
      .ghv-check-box {
        margin: 0 6px 0 0; vertical-align: -1px; accent-color: var(--dsw-alias-brand-primary);
      }
      .ghv-table-wrap { overflow-x: auto; margin: 8px 0; }
      .ghv-table { border-collapse: collapse; font-size: 12px; min-width: 50%; }
      .ghv-table th, .ghv-table td {
        border: 1px solid var(--dsw-alias-border-l1); padding: 4px 8px;
        text-align: left; vertical-align: top;
      }
      .ghv-table th { background: var(--dsw-alias-bg-layer-2); font-weight: 650; }
      /* A live <details>: GitHub uses it to fold long generated output. */
      .ghv-details { margin: 8px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }
      .ghv-details-toggle {
        display: flex; align-items: center; gap: 6px; width: 100%;
        padding: 6px 10px; font: inherit; font-size: 12px; text-align: left; cursor: pointer;
        background: var(--dsw-alias-bg-layer-2); border: 0; color: var(--dsw-alias-label-primary);
      }
      .ghv-details-toggle:hover { filter: brightness(1.06); }
      .ghv-details-caret { color: var(--dsw-alias-label-secondary); flex: none; }
      .ghv-details-count {
        margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary); flex: none;
      }
      .ghv-details-body {
        padding: 8px 11px; border-top: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
      }
      .ghv-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      .ghv-stat {
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 8px 10px;
      }
      .ghv-stat b { display: block; font-size: 16px; font-weight: 650; line-height: 1.2; }
      .ghv-stat span { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
      .ghv-kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 12.5px; }
      .ghv-kv dt { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .ghv-kv dd { margin: 0; word-break: break-word; }
      .ghv-pills { display: flex; gap: 5px; flex-wrap: wrap; }
      .ghv-pill {
        font-size: 10.5px; font-weight: 600; line-height: 17px; padding: 0 8px;
        border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
      }
      .ghv-chip {
        font-size: 11px; font-weight: 650; line-height: 19px; padding: 0 9px; border-radius: 999px;
        border: 1px solid transparent;
      }
      .ghv-open { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
        color: var(--dsw-alias-state-success-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
      .ghv-closed { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
      .ghv-merged { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
        color: var(--dsw-alias-brand-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent); }
      .ghv-draft { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .ghv-checks { display: flex; gap: 6px; flex-wrap: wrap; }
      /* Expandable checks badge and its per-check list. */
      .ghv-check-group { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; }
      .ghv-check-clickable { cursor: pointer; }
      .ghv-check-clickable:hover { background: var(--dsw-alias-bg-layer-2); }
      .ghv-check-caret { color: var(--dsw-alias-label-secondary); margin-left: 1px; font-size: 9px; }
      .ghv-check-list {
        margin-top: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1); overflow: hidden; max-height: 260px; overflow-y: auto;
      }
      .ghv-check-row {
        display: flex; align-items: center; gap: 7px; padding: 4px 9px;
        font-size: 11.5px; border-top: 1px solid var(--dsw-alias-border-l1);
      }
      .ghv-check-row:first-child { border-top: 0; }
      .ghv-check-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ghv-check-state {
        flex: none; font-size: 10px; color: var(--dsw-alias-label-secondary); text-transform: uppercase;
        letter-spacing: .04em;
      }
      .ghv-check {
        display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 7px; padding: 3px 8px;
      }
      .ghv-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .ghv-dot-ok { background: var(--dsw-alias-state-success-primary); }
      .ghv-dot-bad { background: var(--dsw-alias-state-error-primary); }
      .ghv-dot-wait { background: var(--dsw-alias-state-warn-primary); }
      .ghv-dot-none { background: var(--dsw-alias-state-idle-primary); }
      .ghv-bar { display: flex; height: 7px; border-radius: 4px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
      .ghv-bar i { display: block; height: 100%; }
      .ghv-plus { color: var(--dsw-alias-state-success-primary); font-weight: 650; }
      .ghv-minus { color: var(--dsw-alias-state-error-primary); font-weight: 650; }
      .ghv-item {
        display: flex; gap: 8px; padding: 8px 9px; border-radius: 8px; cursor: pointer;
        border: 1px solid transparent; align-items: flex-start;
      }
      .ghv-item:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
      .ghv-item-glyph { flex: none; padding-top: 3px; }
      /* Compact status badges on a list row. */
      .ghv-mini-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
      .ghv-mini {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 10.5px; line-height: 16px; padding: 0 6px; border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1); white-space: nowrap;
      }
      .ghv-mini-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }
      .ghv-mini-bad { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); }
      .ghv-mini-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
      .ghv-mini-idle { color: var(--dsw-alias-state-idle-primary); }
      .ghv-mini-avatar {
        display: inline-flex; align-items: center; justify-content: center;
        width: 12px; height: 12px; border-radius: 50%; font-size: 8px; font-weight: 700;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .ghv-linked { margin-top: 5px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .ghv-linked-pull { color: var(--dsw-alias-brand-primary); }
      .ghv-item-num { flex: none; width: 46px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .ghv-item-main { flex: 1; min-width: 0; }
      .ghv-item-title { font-size: 12.5px; line-height: 1.4; word-break: break-word; }
      .ghv-item-meta { margin-top: 2px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
      .ghv-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 18px 6px; text-align: center; }
      /* Loading: a skeleton keeps a slow fetch from reading as an empty pane. */
      .ghv-loading { padding: 4px 0; }
      .ghv-loading-title {
        display: flex; align-items: center; gap: 7px;
        font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 4px 0 10px;
      }
      .ghv-skeleton {
        display: flex; gap: 8px; padding: 9px 4px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .ghv-skeleton-num {
        width: 40px; height: 11px; flex: none; border-radius: 4px;
        background: var(--dsw-alias-bg-layer-2);
        animation: ghv-pulse 1.4s ease-in-out infinite;
      }
      .ghv-skeleton-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .ghv-skeleton-line {
        height: 11px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2);
        animation: ghv-pulse 1.4s ease-in-out infinite;
      }
      .ghv-skeleton-line-sm { height: 9px; opacity: .7; }
      .ghv-inline-busy {
        display: flex; align-items: center; gap: 6px; padding: 6px 4px 8px;
        font-size: 11.5px; color: var(--dsw-alias-label-secondary);
      }
      @keyframes ghv-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
      .ghv-error {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
        color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 9px 11px;
        font-size: 12px; line-height: 1.5; word-break: break-word;
      }
      .ghv-reply { border-left: 2px solid var(--dsw-alias-border-l1); padding-left: 10px; margin-top: 10px; }
      .ghv-reply-head { display: flex; align-items: center; gap: 4px; font-size: 12px; margin-bottom: 5px; }
      .ghv-reply-head b { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .ghv-reply-time { color: var(--dsw-alias-label-secondary); }
      .ghv-link { color: var(--dsw-alias-brand-primary); text-decoration: none; font-size: 11.5px; }
      .ghv-link:hover { text-decoration: underline; }
      .ghv-avatar {
        display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
        border-radius: 50%; background: var(--dsw-alias-bg-layer-2); font-size: 9px;
        font-weight: 700; margin-right: 4px; overflow: hidden; flex: none; vertical-align: -3px;
      }
      .ghv-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .ghv-foot {
        padding: 7px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
        display: flex; justify-content: space-between; gap: 8px; align-items: center;
      }
      .ghv-spin {
        width: 12px; height: 12px; border-radius: 50%; flex: none;
        border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
        animation: ghv-spin .7s linear infinite;
      }
      @keyframes ghv-spin { to { transform: rotate(360deg); } }
      /* The in-conversation tool card. */
      .ghx-card {
        display: flex; flex-direction: column; gap: 5px; padding: 9px 11px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); max-width: 100%;
      }
      .ghx-head { display: flex; align-items: baseline; gap: 8px; }
      .ghx-name {
        font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
        color: var(--dsw-alias-label-secondary);
      }
      .ghx-muted { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ghx-caption {
        font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary);
        white-space: pre-wrap; word-break: break-word;
      }
      .ghx-image {
        display: block; width: 100%; max-width: 560px; height: auto;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); margin-top: 2px;
      }
      .ghx-error {
        font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary);
        white-space: pre-wrap; word-break: break-word;
      }
    `

    /** One label pill, tinted from GitHub's own label color. */
    function LabelPill({ label }) {
      const style = useMemo(() => {
        const hex = String(label.color ?? '').replace(/[^0-9a-f]/gi, '')
        if (hex.length !== 6) return undefined
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
        return { background: `#${hex}`, borderColor: `#${hex}`, color: light ? '#0d1117' : '#ffffff' }
      }, [label.color])
      return h('span', { className: 'ghv-pill', style }, label.name)
    }

    /** State chip shared by issues and pull requests. */
    function StateChip({ state }) {
      const table = { open: ['ghv-open', 'Open'], closed: ['ghv-closed', 'Closed'], merged: ['ghv-merged', 'Merged'], draft: ['ghv-draft', 'Draft'] }
      const [cls, text] = table[state] ?? table.open
      return h('span', { className: `ghv-chip ${cls}` }, text)
    }

    /** Avatar with an initial fallback. */
    function Avatar({ user }) {
      const [broken, setBroken] = useState(false)
      const initial = String(user?.login ?? '?').slice(0, 1).toUpperCase()
      return h(
        'span',
        { className: 'ghv-avatar' },
        user?.avatar && !broken
          ? h('img', { src: safeUrl(user.avatar) || undefined, alt: '', referrerPolicy: 'no-referrer', onError: () => setBroken(true) })
          : initial,
      )
    }

    /** Strip the noise markdown leaves in a one-line excerpt. */
    /**
     * The repository strip.
     *
     * Three ways to pick a repository, in decreasing automation:
     *   1. a workspace — the panel detects that directory's git remotes;
     *   2. a remote of that workspace, when `origin` and `upstream` disagree;
     *   3. a typed `owner/repo`.
     *
     * The workspace is the scope, never a global preference: switching the
     * workspace switches the detected repository with it.
     */
    function LookupBar({
      workspaces, activeDir, remotes, repoText, setRepoText,
      onWorkspace, onRemote, onRepo, onError, busy, setBusy,
    }) {
      const openRepo = useCallback(async () => {
        const value = repoText.trim()
        if (value === '') return
        setBusy(true)
        onError(null)
        try {
          await onRepo(value)
        } catch (error) {
          onError(error.message)
        } finally {
          setBusy(false)
        }
      }, [repoText, onRepo, onError, setBusy])

      const hasChoice = (remotes?.remotes?.length ?? 0) > 1

      return h(
        'div',
        { className: 'ghv-search' },
        workspaces.length > 0
          ? h(
              'div',
              { className: 'ghv-row', style: { marginBottom: 6 } },
              h(
                'select',
                {
                  className: 'ghv-input ghv-select',
                  value: activeDir ?? '',
                  'aria-label': 'Workspace',
                  onChange: (event) => onWorkspace(event.target.value),
                },
                h('option', { value: '' }, 'This session’s directory'),
                workspaces.map((workspace) =>
                  h('option', { key: workspace.path, value: workspace.path }, workspace.title)),
              ),
              remotes?.preferred
                ? h('span', { className: 'ghv-src', title: `Detected from ${remotes.dir ?? 'git remotes'}` },
                    remotes.upstream ? 'upstream' : 'origin')
                : null,
            )
          : null,
        hasChoice
          ? h(
              'div',
              { className: 'ghv-row', style: { marginBottom: 6 } },
              h(
                'select',
                {
                  className: 'ghv-input ghv-select',
                  value: repoText,
                  'aria-label': 'Repository remote',
                  onChange: (event) => {
                    setRepoText(event.target.value)
                    void (async () => {
                      setBusy(true)
                      onError(null)
                      try {
                        await onRepo(event.target.value)
                      } catch (error) {
                        onError(error.message)
                      } finally {
                        setBusy(false)
                      }
                    })()
                  },
                },
                remotes.remotes.map((remote) =>
                  h('option', { key: remote.name, value: remote.repo }, `${remote.name} → ${remote.repo}`)),
              ),
              h('span', { className: 'ghv-src' }, 'remote'),
            )
          : null,
        h(
          'div',
          { className: 'ghv-row' },
          h('input', {
            className: 'ghv-input',
            placeholder: 'owner/repo',
            value: repoText,
            spellCheck: false,
            'aria-label': 'Repository',
            onChange: (event) => setRepoText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void openRepo()
            },
          }),
          h('button', { className: 'ghv-btn ghv-btn-primary', onClick: () => void openRepo(), disabled: busy }, 'Open'),
        ),
      )
    }

    /**
     * Human labels for GitHub's alert callouts.
     */
    const ALERT_LABEL = {
      NOTE: 'Note',
      TIP: 'Tip',
      IMPORTANT: 'Important',
      WARNING: 'Warning',
      CAUTION: 'Caution',
    }

    /**
     * The repository whose markdown is being rendered right now.
     *
     * Relative image and link paths in a README (`/docs/x.png`, `docs/x.png`)
     * only resolve against the repository they came from. `renderInline` is a
     * plain function rather than a component, so the owner is passed down
     * through this one cell instead of threading an argument through every
     * recursive call. It is set by `MarkdownBody` on each render and read
     * synchronously, so concurrent panels each see their own value.
     */
    let renderOwner = null

    /**
     * Resolve a README-relative URL against the repository being rendered.
     * Anything already absolute (http/https, data, or protocol-relative) is left
     * alone.
     */
    /**
     * Reduce any URL found in a body to one that is safe to put in an `href` or
     * `src`.
     *
     * Issue bodies and READMEs are written by strangers, and `[x](javascript:…)`
     * renders as a live link: React only warns in development and leaves the
     * attribute in place in production. Anything that is not plain http(s),
     * mailto, a hash anchor, or a data image is dropped to `''`, which callers
     * treat as "no link / no image".
     */
    function safeUrl(url) {
      const raw = String(url ?? '').trim()
      if (raw === '') return ''
      // Strip the control characters a scheme check can be fooled by
      // (`java\tscript:` and friends).
      const cleaned = raw.replace(/[\u0000-\u001F\u007F\s]/g, '')
      if (/^#/.test(cleaned)) return raw
      if (/^(?:https?|mailto):/i.test(cleaned)) return raw
      if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(cleaned)) return raw
      if (cleaned.startsWith('//')) return raw
      return ''
    }

    /**
     * Resolve a README-relative URL against the repository being rendered.
     * Anything already absolute (http/https, data, or protocol-relative) is left
     * alone; anything else is resolved into the repository, which is what makes
     * `javascript:` and `file:` unreachable rather than merely blocked.
     */
    function resolveAssetUrl(url) {
      const raw = String(url ?? '').trim()
      if (raw === '') return ''
      const safe = safeUrl(raw)
      if (safe !== '') return safe
      // Not an allowed absolute URL, so treat it as a path inside the repo. This
      // is also what turns a hostile `javascript:alert(1)` into a dead
      // raw.githubusercontent.com path instead of a live link.
      const owner = renderOwner
      const path = raw.replace(/^\.\//, '').replace(/^\//, '')
      if (owner === null) return ''
      // Normalize already-escaped segments before encoding so `%20` does not
      // become `%2520`, and keep `HEAD` as the ref: raw.githubusercontent needs
      // a ref between the repository and the path, and without one every
      // repository-relative README image would 404.
      const encoded = path.split('/').map((segment) => {
        let decoded = segment
        try {
          decoded = decodeURIComponent(segment)
        } catch {
          // A literal `%` that is not an escape stays as written.
        }
        return encodeURIComponent(decoded)
      }).join('/')
      return `https://raw.githubusercontent.com/${owner}/HEAD/${encoded}`
    }

    /**
     * Render one image reference.
     *
     * `loading="lazy"` keeps a long README from firing dozens of requests at
     * once, and `onError` replaces a broken badge with its alt text instead of
     * leaving an empty box.
     */
    function renderImage(alt, src, key, width) {
      const url = resolveAssetUrl(src)
      if (url === '') return ''
      const style = { maxWidth: '100%', height: 'auto', display: 'inline-block', verticalAlign: 'middle' }
      if (Number.isFinite(width) && width > 0) style.width = width
      return h('img', {
        key,
        src: url,
        alt: alt ?? '',
        loading: 'lazy',
        referrerPolicy: 'no-referrer',
        className: 'ghv-md-img',
        style,
        onError: (event) => {
          // Keep the layout stable: swap the failed image for its alt text.
          const img = event.currentTarget
          const label = img.alt || 'image'
          img.replaceWith(Object.assign(document.createTextNode(label), {}))
        },
      })
    }

    /**
     * Render one inline markdown fragment to React nodes.
     *
     * Handles the inline vocabulary real issue and PR text uses: inline code,
     * links, images, bold, italic, strikethrough, autolinks, and the small set
     * of HTML tags GitHub allows through — `<strong>`, `<em>`, `<code>`,
     * `<del>`, `<sub>`, `<sup>`, `<br>`, `<kbd>` and task-list checkboxes.
     * Raw HTML is never injected as markup, so a body cannot smuggle a script
     * or a style rule into the app.
     *
     * @param {string} raw source fragment
     * @returns {Array<React.ReactNode>} renderable parts
     */
    function renderInline(raw) {
      const parts = []
      /*
       * One pass, one alternation: order matters — code first so its contents
       * are never interpreted, then images/links, then emphasis, then HTML.
       *
       * Link and image text uses a bracket-balancing group `((?:[^\[\]]|\[[^\]]*\])*)`
       * rather than `[^\]]*`: README badges are written `[![alt](img)](link)`, and
       * a class that refuses nested brackets chops that into `![alt` plus stray
       * punctuation. One level of nesting covers every badge shield in practice.
       */
      const pattern = new RegExp([
        '`([^`]+)`', // 1 inline code
        '!\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]\\(([^)\\s]+)\\)', // 2,3 image
        '\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]\\(([^)\\s]+)\\)', // 4,5 link
        '\\*\\*([^*]+)\\*\\*', // 6 bold
        '__([^_]+)__', // 7 bold
        '(?<!\\w)\\*([^*\\n]+)\\*(?!\\w)', // 8 italic
        '(?<!\\w)_([^_\\n]+)_(?!\\w)', // 9 italic
        '~~([^~]+)~~', // 10 strike
        '<(strong|b)(?:\\s[^>]*)?>([\\s\\S]*?)</(?:strong|b)>', // 11,12 html bold
        '<(em|i)(?:\\s[^>]*)?>([\\s\\S]*?)</(?:em|i)>', // 13,14 html italic
        '<(code)(?:\\s[^>]*)?>([\\s\\S]*?)</code>', // 15,16 html code
        '<(del|s)(?:\\s[^>]*)?>([\\s\\S]*?)</(?:del|s)>', // 17,18 html strike
        '<(sub|sup)(?:\\s[^>]*)?>([\\s\\S]*?)</(?:sub|sup)>', // 19,20 html sub/sup
        '<(kbd)(?:\\s[^>]*)?>([\\s\\S]*?)</kbd>', // 21,22 html kbd
        '<input\\b[^>]*type=["\']?checkbox["\']?[^>]*>', // 23 task checkbox
        '<br\\s*/?>', // 24 break
        '<a\\b[^>]*href=["\']([^"\']+)["\'][^>]*>([\\s\\S]*?)</a>', // 25,26 html link
        '<img\\b[^>]*>', // 27 raw html image
      ].join('|'), 'g')
      let cursor = 0
      let match
      let key = 0
      while ((match = pattern.exec(raw)) !== null) {
        if (match.index > cursor) parts.push(raw.slice(cursor, match.index))
        const [whole] = match
        const push = (node) => parts.push(node)
        if (match[1] !== undefined) {
          push(h('code', { className: 'ghv-inline-code', key: key++ }, match[1]))
        } else if (match[3] !== undefined) {
          // A README badge or screenshot is content, not a link: render the
          // image. Shields and badges degrade to alt text on their own when the
          // remote refuses the request, so a broken host costs nothing.
          push(renderImage(match[2], match[3], key++))
        } else if (match[5] !== undefined) {
          // Link text may itself be an image (`[![alt](img)](link)`), so it is
          // parsed rather than emitted as a string.
          push(h('a', { className: 'ghv-link', key: key++, href: safeUrl(match[5]) || undefined, target: '_blank', rel: 'noreferrer' },
            match[4] === '' ? match[5] : renderInline(match[4])))
        } else if (match[6] !== undefined || match[7] !== undefined) {
          push(h('strong', { key: key++ }, renderInline(match[6] ?? match[7])))
        } else if (match[8] !== undefined || match[9] !== undefined) {
          push(h('em', { key: key++ }, renderInline(match[8] ?? match[9])))
        } else if (match[10] !== undefined) {
          push(h('del', { key: key++ }, match[10]))
        } else if (match[12] !== undefined) {
          push(h('strong', { key: key++ }, renderInline(match[12])))
        } else if (match[14] !== undefined) {
          push(h('em', { key: key++ }, renderInline(match[14])))
        } else if (match[16] !== undefined) {
          push(h('code', { className: 'ghv-inline-code', key: key++ }, match[16]))
        } else if (match[18] !== undefined) {
          push(h('del', { key: key++ }, match[18]))
        } else if (match[19] !== undefined) {
          push(h(match[19], { key: key++ }, match[20]))
        } else if (match[22] !== undefined) {
          push(h('kbd', { className: 'ghv-kbd', key: key++ }, match[22]))
        } else if (/^<input/i.test(whole)) {
          const checked = /\bchecked\b/i.test(whole)
          push(h('input', {
            key: key++, type: 'checkbox', className: 'ghv-check-box',
            checked, readOnly: true, tabIndex: -1, disabled: true,
          }))
        } else if (/^<br/i.test(whole)) {
          push(h('br', { key: key++ }))
        } else if (/^<img/i.test(whole)) {
          // Raw <img> in a README (`<img src="docs/x.png" width="256">`).
          const src = /\bsrc=["']([^"']+)["']/i.exec(whole)?.[1]
          const alt = /\balt=["']([^"']*)["']/i.exec(whole)?.[1] ?? ''
          const width = Number(/\bwidth=["']?(\d+)/i.exec(whole)?.[1] ?? 0)
          push(src === undefined ? '' : renderImage(alt, src, key++, width))
        } else if (match[23] !== undefined) {
          push(h('a', { className: 'ghv-link', key: key++, href: safeUrl(match[23]) || undefined, target: '_blank', rel: 'noreferrer' },
            renderInline(match[24])))
        }
        cursor = match.index + whole.length
      }
      if (cursor < raw.length) parts.push(raw.slice(cursor))
      return parts
    }

    /**
     * A markdown body rendered the way the GitHub web UI reads.
     *
     * Real issue and PR text is not plain markdown: it carries HTML comments
     * (CodeRabbit's generated notices), `<details>`/`<summary>` blocks, task-list
     * checkboxes and inline HTML. Line-at-a-time parsing leaves those markers
     * visible as literal text, so this walks block structure instead and strips
     * comments entirely. It is still not a full markdown engine — deliberately,
     * since the app renders untrusted text and a parser bug must not become an
     * injection.
     */
    function MarkdownBody({ text, collapsedLines = 18, owner }) {
      const [expanded, setExpanded] = useState(false)
      const [openDetails, setOpenDetails] = useState({})

      // Relative asset paths resolve against the repository being rendered.
      // Set during render, which is synchronous, so two panels never interleave.
      renderOwner = owner ?? null

      // HTML comments are authoring noise; GitHub hides them and so do we.
      // Done first, because a comment can span the lines a block parser reads.
      const cleaned = String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const lines = cleaned.split('\n')
      const isLong = lines.length > collapsedLines || cleaned.length > 1200
      const shown = expanded || !isLong ? lines : lines.slice(0, collapsedLines)

      /** Group lines into blocks: fences, details, quotes, headings, lists, text. */
      const blocks = []
      let index = 0
      while (index < shown.length) {
        const line = shown[index]

        const fenceMatch = /^\s{0,3}(```|~~~)(.*)$/.exec(line)
        if (fenceMatch) {
          const lang = fenceMatch[2].trim()
          const body = []
          index += 1
          while (index < shown.length && !/^\s{0,3}(```|~~~)\s*$/.test(shown[index])) {
            body.push(shown[index])
            index += 1
          }
          index += 1 // consume the closing fence
          blocks.push({ kind: 'code', lang, lines: body })
          continue
        }

        // <details> is how GitHub collapses long generated text; keep it live so
        // the reader can open it instead of scrolling past thousands of lines.
        const detailsOpen = /^\s*<details\b/i.exec(line)
        if (detailsOpen) {
          const summary = []
          const body = []
          index += 1
          // A <summary> may contain markdown or nested tags; take its text.
          if (index < shown.length && /^\s*<summary\b/i.test(shown[index])) {
            let summaryText = shown[index].replace(/^\s*<summary[^>]*>/i, '')
            index += 1
            while (index < shown.length && !/<\/summary>/i.test(summaryText)) {
              summaryText += `\n${shown[index]}`
              index += 1
            }
            summary.push(summaryText.replace(/<\/summary>[\s\S]*$/i, '').trim())
          }
          while (index < shown.length && !/<\/details>/i.test(shown[index])) {
            body.push(shown[index])
            index += 1
          }
          index += 1 // consume </details>
          blocks.push({ kind: 'details', summary: summary[0] ?? 'Details', body, id: blocks.length })
          continue
        }

        if (/^\s*<summary\b/i.test(line) || /^\s*<\/?(details|div|p|table|tr|td|th)\b/i.test(line)) {
          // A stray structural tag with no matching opener: drop the tag, keep
          // any text it wrapped so nothing silently disappears.
          const textLeft = line.replace(/<[^>]+>/g, '').trim()
          if (textLeft !== '') blocks.push({ kind: 'text', text: textLeft })
          index += 1
          continue
        }

        // A standalone <img> is content, not a paragraph of markup: render it
        // rather than letting the block parser emit the tag as text.
        if (/^\s*<img\b/i.test(line) && /^\s*<img\b[^>]*\/?>\s*$/i.test(line)) {
          blocks.push({ kind: 'html', text: line.trim() })
          index += 1
          continue
        }

        if (/^\s*<hr\s*\/?>/i.test(line)) {
          blocks.push({ kind: 'rule' })
          index += 1
          continue
        }

        if (/^\s{0,3}>/.test(line)) {
          const quote = []
          while (index < shown.length && /^\s{0,3}>/.test(shown[index])) {
            quote.push(shown[index].replace(/^\s{0,3}>\s?/, ''))
            index += 1
          }
          // GitHub's alert syntax: `> [!IMPORTANT]` and friends render as a
          // labelled callout, not as a literal bracketed line.
          const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(quote[0]?.trim() ?? '')
          if (alert) {
            const kind = alert[1].toUpperCase()
            const rest = []
            let at = 1
            // The title is the first heading or paragraph after the marker.
            while (at < quote.length && quote[at].trim() === '') at += 1
            const titleLine = quote[at] ?? ''
            const titleMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(titleLine)
            const title = titleMatch ? titleMatch[2] : ''
            if (titleMatch) at += 1
            for (; at < quote.length; at += 1) rest.push(quote[at])
            blocks.push({ kind: 'alert', alertKind: kind, title, lines: rest })
            continue
          }
          blocks.push({ kind: 'quote', lines: quote })
          continue
        }

        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') })
          index += 1
          continue
        }

        // A run of list items, with their indented continuation lines.
        const listStart = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (listStart) {
          const items = []
          while (index < shown.length) {
            const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(shown[index])
            if (!item) {
              // A blank line ends the list; a deeper indent continues the item.
              if (shown[index].trim() === '') break
              if (items.length > 0) items[items.length - 1].text += `\n${shown[index].trim()}`
              index += 1
              continue
            }
            items.push({
              ordered: /\d/.test(item[2]),
              marker: item[2],
              indent: item[1].length,
              text: item[3],
            })
            index += 1
          }
          blocks.push({ kind: 'list', items })
          continue
        }

        // A table: a header row, a separator row, then body rows.
        if (/\|/.test(line) && index + 1 < shown.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(shown[index + 1])) {
          const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
          const head = cells(line)
          const rows = []
          index += 2
          while (index < shown.length && /\|/.test(shown[index]) && shown[index].trim() !== '') {
            rows.push(cells(shown[index]))
            index += 1
          }
          blocks.push({ kind: 'table', head, rows })
          continue
        }

        if (line.trim() === '') {
          blocks.push({ kind: 'gap' })
          index += 1
          continue
        }

        // Consecutive plain lines form one paragraph, keeping their breaks.
        const para = []
        while (index < shown.length) {
          const next = shown[index]
          if (next.trim() === '') break
          if (/^\s{0,3}(```|~~~)/.test(next)) break
          if (/^\s*<details\b/i.test(next)) break
          if (/^\s{0,3}>/.test(next)) break
          if (/^\s{0,3}#{1,6}\s+/.test(next)) break
          if (/^(\s*)([-*+]|\d+[.)])\s+/.test(next)) break
          para.push(next)
          index += 1
        }
        if (para.length === 0) {
          // A line no block parser accepted must still consume input. A Unicode
          // line separator can defeat the full-line regexes above while the
          // prefix checks here still match; without this the loop would spin on
          // that line forever.
          blocks.push({ kind: 'text', text: line })
          index += 1
          continue
        }
        blocks.push({ kind: 'text', text: para.join('\n') })
      }

      /** Render a body block list, shared by the top level and <details>. */
      const renderBlocks = (list, prefix = 'b') =>
        list.slice(0, 500).map((block, blockIndex) => {
          const key = `${prefix}${blockIndex}`
          if (block.kind === 'code') {
            return h('pre', { className: 'ghv-code', key }, h('code', null, block.lines.join('\n')))
          }
          if (block.kind === 'rule') return h('div', { className: 'ghv-md-rule', key })
          if (block.kind === 'html') {
            // A standalone tag line, already known to be an <img>.
            return h('div', { className: 'ghv-md-figure', key }, renderInline(block.text))
          }
          if (block.kind === 'gap') return h('div', { className: 'ghv-md-gap', key })
          if (block.kind === 'quote') {
            return h('blockquote', { className: 'ghv-quote', key }, renderInline(block.lines.join('\n')))
          }
          if (block.kind === 'alert') {
            return h('div', { className: `ghv-alert ghv-alert-${block.alertKind.toLowerCase()}`, key },
              h('div', { className: 'ghv-alert-head' }, ALERT_LABEL[block.alertKind] ?? block.alertKind),
              block.title ? h('div', { className: 'ghv-alert-title' }, renderInline(block.title)) : null,
              h('div', { className: 'ghv-alert-body' }, renderBlocks(parseDetails(block.lines), `${key}-`)))
          }
          if (block.kind === 'heading') {
            return h('div', { className: `ghv-md-h ghv-md-h${block.level}`, key }, renderInline(block.text))
          }
          if (block.kind === 'list') {
            return h('div', { className: 'ghv-md-list', key },
              block.items.map((item, itemIndex) => {
                // GitHub task lists: `- [ ]` / `- [x]` render a real checkbox
                // instead of the literal brackets.
                const task = /^\[([ xX])\]\s*(.*)$/.exec(item.text)
                return h('div', {
                  className: `ghv-md-li${item.ordered ? '' : ' ghv-md-li-bullet'}${task ? ' ghv-md-li-task' : ''}`,
                  key: itemIndex,
                  style: { paddingLeft: 2 + Math.min(item.indent, 12) * 0.9 },
                },
                  task
                    ? h('input', {
                        type: 'checkbox', className: 'ghv-check-box',
                        checked: task[1].toLowerCase() === 'x',
                        readOnly: true, tabIndex: -1, disabled: true,
                      })
                    : (item.ordered ? `${item.marker} ` : '• '),
                  renderInline(task ? task[2] : item.text))
              }))
          }
          if (block.kind === 'table') {
            return h('div', { className: 'ghv-table-wrap', key },
              h('table', { className: 'ghv-table' },
                h('thead', null, h('tr', null, block.head.map((cell, cellIndex) =>
                  h('th', { key: cellIndex }, renderInline(cell))))),
                h('tbody', null, block.rows.map((row, rowIndex) =>
                  h('tr', { key: rowIndex }, row.map((cell, cellIndex) =>
                    h('td', { key: cellIndex }, renderInline(cell))))))))
          }
          if (block.kind === 'details') {
            const open = openDetails[block.index] ?? false
            return h('div', { className: 'ghv-details', key },
              h('button', {
                className: 'ghv-details-toggle',
                'aria-expanded': open,
                onClick: () => setOpenDetails((previous) => ({ ...previous, [block.index]: !open })),
              },
                h('span', { className: 'ghv-details-caret' }, open ? '▾' : '▸'),
                renderInline(block.summary || 'Details'),
                h('span', { className: 'ghv-details-count' }, `${block.body.length} lines`)),
              open ? h('div', { className: 'ghv-details-body' }, renderBlocks(parseDetails(block.body), `${key}-`)) : null)
          }
          return h('div', { className: 'ghv-md-p', key }, renderInline(block.text))
        })

      /** Parse one <details> body with the same block rules. */
      function parseDetails(bodyLines) {
        const nested = []
        let at = 0
        while (at < bodyLines.length) {
          const line = bodyLines[at]
          const fence = /^\s{0,3}(```|~~~)(.*)$/.exec(line)
          if (fence) {
            const body = []
            at += 1
            while (at < bodyLines.length && !/^\s{0,3}(```|~~~)\s*$/.test(bodyLines[at])) {
              body.push(bodyLines[at])
              at += 1
            }
            at += 1
            nested.push({ kind: 'code', lang: fence[2].trim(), lines: body })
            continue
          }
          const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
          if (heading) {
            nested.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
            at += 1
            continue
          }
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
          if (item) {
            const items = []
            while (at < bodyLines.length) {
              const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(bodyLines[at])
              if (!next) break
              items.push({ ordered: /\d/.test(next[2]), marker: next[2], indent: next[1].length, text: next[3] })
              at += 1
            }
            nested.push({ kind: 'list', items })
            continue
          }
          if (line.trim() === '') { nested.push({ kind: 'gap' }); at += 1; continue }
          nested.push({ kind: 'text', text: line })
          at += 1
        }
        return nested
      }

      // Give each details block a stable index for its open/closed state.
      let detailsSeen = 0
      for (const block of blocks) {
        if (block.kind === 'details') block.index = detailsSeen++
      }

      return h('div', { className: 'ghv-md' },
        renderBlocks(blocks),
        isLong
          ? h('button', {
              className: 'ghv-more',
              onClick: () => setExpanded((value) => !value),
            }, expanded ? 'Show less' : `Show ${lines.length - collapsedLines} more lines`)
          : null)
    }

    /** The `#123` jump box. */
    function JumpBar({ onSubmit, busy, compact = false }) {
      const [text, setText] = useState('')
      const submit = useCallback(() => {
        const value = text.trim()
        if (value === '') return
        onSubmit(value)
        setText('')
      }, [text, onSubmit])
      return h(
        'div',
        compact
          ? { className: 'ghv-jump-compact' }
          : { className: 'ghv-search', style: { borderBottom: 0, paddingTop: 0 } },
        h(
          'div',
          { className: 'ghv-row' },
          h('input', {
            className: 'ghv-input',
            placeholder: compact ? '#123' : 'Jump to #123 (issue or PR)',
            value: text,
            spellCheck: false,
            'aria-label': 'Issue or pull request number',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
            },
          }),
          h('button', { className: 'ghv-btn', onClick: submit, disabled: busy }, 'Jump'),
        ),
      )
    }

    /** Repo overview body. */
    function RepoView({ data }) {
      // The README is fetched on demand, once per repository: the overview is
      // useful without it, and a large README should not delay the panel.
      const [readme, setReadme] = useState(null)
      const [readmeState, setReadmeState] = useState('idle')

      useEffect(() => {
        let live = true
        setReadmeState('loading')
        setReadme(null)
        call('readme', { repo: data.fullName })
          .then((result) => {
            if (!live) return
            setReadme(result ?? null)
            setReadmeState('ready')
          })
          .catch(() => { if (live) setReadmeState('error') })
        return () => { live = false }
      }, [data.fullName])

      const stats = [
        [compact(data.stars), 'stars'],
        [compact(data.forks), 'forks'],
        [compact(data.watchers), 'watching'],
        [data.openIssues === null ? '—' : compact(data.openIssues), 'issues'],
        [data.openPulls === null ? '—' : compact(data.openPulls), 'PRs'],
      ]
      const facts = [
        data.language ? ['Language', data.language] : null,
        data.license ? ['License', data.license] : null,
        data.defaultBranch ? ['Default branch', data.defaultBranch] : null,
        data.latestRelease ? ['Latest release', `${data.latestRelease.tag}${data.latestRelease.at ? ` · ${ago(data.latestRelease.at)}` : ''}`] : null,
        data.homepage ? ['Homepage', data.homepage] : null,
        data.pushedAt ? ['Last push', ago(data.pushedAt)] : null,
      ].filter(Boolean)
      return h(
        'div',
        null,
        data.description ? h('div', { className: 'ghv-box', style: { marginBottom: 12 } }, data.description) : null,
        h('div', { className: 'ghv-stats', style: { marginBottom: 14 } },
          stats.map(([value, label]) => h('div', { className: 'ghv-stat', key: label }, h('b', null, value), h('span', null, label)))),
        facts.length
          ? h('dl', { className: 'ghv-kv ghv-section' },
              facts.flatMap(([key, value]) => [h('dt', { key: `${key}-k` }, key), h('dd', { key: `${key}-v` }, value)]))
          : null,
        data.topics?.length
          ? h('div', { className: 'ghv-section' },
              h('div', { className: 'ghv-label' }, 'Topics'),
              h('div', { className: 'ghv-pills' }, data.topics.slice(0, 12).map((topic) => h('span', { className: 'ghv-pill', key: topic }, topic))))
          : null,
        h('a', { className: 'ghv-link', href: safeUrl(data.url) || undefined, target: '_blank', rel: 'noreferrer' }, 'Open on GitHub ↗'),
        h('div', { className: 'ghv-section', style: { marginTop: 16 } },
          h('div', { className: 'ghv-label' }, 'Readme'),
          readmeState === 'loading'
            ? h('div', { className: 'ghv-loading-inline' }, h('span', { className: 'ghv-spin' }), ' Loading readme…')
            : readmeState === 'error'
              ? h('div', { className: 'ghv-box ghv-box-empty' }, 'Could not load the readme.')
              : readme === null
                ? h('div', { className: 'ghv-box ghv-box-empty' }, 'This repository has no readme.')
                : h(MarkdownBody, { text: readme.markdown, collapsedLines: 30, owner: data.fullName })),
      )
    }

    /** Issue body. */
    function IssueView({ data }) {
      return h(
        'div',
        null,
        h('h2', { className: 'ghv-h1' }, h('span', { className: 'ghv-num' }, `#${data.number} `), data.title),
        h('div', { className: 'ghv-meta', style: { marginBottom: 10 } },
          h(StateChip, { state: data.state }),
          h('span', null, h(Avatar, { user: data.author }), data.author.login),
          h('span', null, `opened ${ago(data.createdAt)}`),
          h('span', null, `${data.comments} comments`),
          (data.assignees ?? []).length ? h('span', null, `assigned to ${data.assignees.join(', ')}`) : null,
          data.milestone ? h('span', null, `milestone ${data.milestone}`) : null),
        data.labels?.length ? h('div', { className: 'ghv-pills ghv-section' }, data.labels.map((label) => h(LabelPill, { key: label.name, label }))) : null,
        data.body ? h(MarkdownBody, { text: data.body, owner: data.repo }) : h('div', { className: 'ghv-box ghv-box-empty' }, 'No description.'),
        // Comments render as markdown too, collapsed until the reader asks for
        // the rest — truncating with "…" threw away formatting the reader needs.
        data.replies?.length
          ? h('div', { className: 'ghv-section' },
              h('div', { className: 'ghv-label' }, `${data.replies.length} comment${data.replies.length === 1 ? '' : 's'}`),
              data.replies.map((reply, index) =>
                h('div', { className: 'ghv-reply', key: index },
                  h('div', { className: 'ghv-reply-head' },
                    h(Avatar, { user: reply.author }),
                    h('b', null, reply.author.login),
                    h('span', { className: 'ghv-reply-time' }, ` · ${ago(reply.createdAt)}`)),
                  h(MarkdownBody, { text: reply.body, collapsedLines: 10, owner: data.repo }))))
          : null,
        h('a', { className: 'ghv-link', href: safeUrl(data.url) || undefined, target: '_blank', rel: 'noreferrer' }, `Open issue #${data.number} ↗`),
      )
    }

    /** Pull request body: size, checks, reviews. */
    function PullView({ data }) {
      const checks = data.checks ?? { state: 'none', success: 0, failure: 0, pending: 0, failing: [] }
      const dot = { passing: 'ghv-dot-ok', failing: 'ghv-dot-bad', pending: 'ghv-dot-wait' }[checks.state] ?? 'ghv-dot-none'
      const checkText = {
        passing: `Checks passing (${checks.success})`,
        failing: `Checks failing (${checks.failure})`,
        pending: `Checks running (${checks.pending})`,
        none: 'No checks',
      }[checks.state]
      const approved = data.approvals?.length ?? 0
      const blocked = data.changesRequested?.length ?? 0
      // GitHub's own verdict wins when present: it accounts for the branch's
      // required-review rule, which a raw approval count cannot express.
      const decision = String(data.reviewDecision ?? '').toUpperCase()
      const reviewText = decision === 'APPROVED' ? 'Approved'
        : decision === 'CHANGES_REQUESTED' ? 'Changes requested'
          : decision === 'REVIEW_REQUIRED' ? 'Required review pending'
            : approved > 0 && blocked === 0 ? `Approved by ${approved}`
              : blocked > 0 ? `Changes requested by ${blocked}`
                : 'Awaiting review'
      const reviewDot = decision === 'APPROVED' || (approved > 0 && blocked === 0 && decision === '')
        ? 'ghv-dot-ok'
        : decision === 'CHANGES_REQUESTED' || blocked > 0 ? 'ghv-dot-bad' : 'ghv-dot-wait'
      const total = data.additions + data.deletions
      const plusPct = total === 0 ? 0 : Math.round((data.additions / total) * 100)

      return h(
        'div',
        null,
        h('h2', { className: 'ghv-h1' }, h('span', { className: 'ghv-num' }, `#${data.number} `), data.title),
        h('div', { className: 'ghv-meta', style: { marginBottom: 10 } },
          h(StateChip, { state: data.state }),
          h('span', null, h(Avatar, { user: data.author }), data.author.login),
          h('span', null, `${data.branch.head} → ${data.branch.base}`),
          data.isDraft ? h('span', { className: 'ghv-mini ghv-mini-idle' }, 'Draft') : null,
          (data.assignees ?? []).length
            ? h('span', null, `assigned to ${data.assignees.join(', ')}`)
            : null),
        data.labels?.length ? h('div', { className: 'ghv-pills ghv-section' }, data.labels.map((label) => h(LabelPill, { key: label.name, label }))) : null,
        data.body ? h(MarkdownBody, { text: data.body, owner: data.repo }) : h('div', { className: 'ghv-box ghv-box-empty' }, 'No description.'),
        h('div', { className: 'ghv-stats', style: { marginTop: 12 } },
          h('div', { className: 'ghv-stat' }, h('b', null, compact(data.changedFiles)), h('span', null, 'files')),
          h('div', { className: 'ghv-stat' }, h('b', null, compact(data.commits)), h('span', null, 'commits')),
          h('div', { className: 'ghv-stat' }, h('b', null, compact(data.comments)), h('span', null, 'comments'))),
        h('div', { className: 'ghv-row', style: { marginTop: 10, alignItems: 'center' } },
          h('span', { className: 'ghv-plus' }, `+${data.additions}`),
          h('span', { className: 'ghv-minus' }, `−${data.deletions}`),
          h('span', { className: 'ghv-bar' },
            h('i', { style: { width: `${plusPct}%`, background: 'var(--dsw-alias-state-success-primary)' } }),
            h('i', { style: { width: `${100 - plusPct}%`, background: 'var(--dsw-alias-state-error-primary)' } }))),
        h('div', { className: 'ghv-checks ghv-section', style: { marginTop: 12 } },
          h(CheckBadge, { checks, dot, text: checkText }),
          h('span', { className: 'ghv-check' }, h('span', { className: `ghv-dot ${reviewDot}` }), reviewText),
          data.isDraft ? h('span', { className: 'ghv-check' }, h('span', { className: 'ghv-dot ghv-dot-wait' }), 'Draft') : null,
          data.state === 'open' && data.mergeable === false
            ? h('span', { className: 'ghv-check' }, h('span', { className: 'ghv-dot ghv-dot-bad' }), 'Conflicts')
            : null),
        checks.failing?.length ? h('div', { className: 'ghv-error', style: { marginBottom: 12 } }, `Failing: ${checks.failing.join(', ')}`) : null,
        data.replies?.length
          ? h('div', { className: 'ghv-section' },
              h('div', { className: 'ghv-label' }, `${data.replies.length} comment${data.replies.length === 1 ? '' : 's'}`),
              data.replies.map((reply, index) =>
                h('div', { className: 'ghv-reply', key: index },
                  h('div', { className: 'ghv-reply-head' },
                    h(Avatar, { user: reply.author }),
                    h('b', null, reply.author.login),
                    h('span', { className: 'ghv-reply-time' }, ` · ${ago(reply.createdAt)}`)),
                  h(MarkdownBody, { text: reply.body, collapsedLines: 10, owner: data.repo }))))
          : null,
        h('a', { className: 'ghv-link', href: safeUrl(data.url) || undefined, target: '_blank', rel: 'noreferrer' }, `Open pull request #${data.number} ↗`),
      )
    }

    /**
     * The status-checks badge, expanded into the individual checks on click.
     *
     * A count alone only answers "is it green"; the next question is always
     * "which one", so the badge opens the per-check list instead of sending the
     * reader to GitHub. Failing checks sort first — that is what the reader came
     * for — and a check with a URL links to its log.
     */
    function CheckBadge({ checks, dot, text }) {
      const [open, setOpen] = useState(false)
      const items = checks?.items ?? []
      const expandable = items.length > 0

      // Failing → running → the rest, so the useful rows are at the top.
      const order = { failure: 0, pending: 1, neutral: 2, skipped: 3, success: 4 }
      const sorted = useMemo(
        () => [...items].sort((left, right) => (order[left.state] ?? 9) - (order[right.state] ?? 9)),
        [items],
      )

      const head = h('span', {
        className: `ghv-check${expandable ? ' ghv-check-clickable' : ''}`,
        role: expandable ? 'button' : undefined,
        tabIndex: expandable ? 0 : undefined,
        'aria-expanded': expandable ? open : undefined,
        title: expandable ? 'Show the individual checks' : undefined,
        onClick: expandable ? () => setOpen((value) => !value) : undefined,
        onKeyDown: expandable
          ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((v) => !v) } }
          : undefined,
      },
        h('span', { className: `ghv-dot ${dot}` }),
        text,
        expandable ? h('span', { className: 'ghv-check-caret' }, open ? '▾' : '▸') : null)

      return h('div', { className: 'ghv-check-group' },
        head,
        expandable && open
          ? h('div', { className: 'ghv-check-list' },
              sorted.map((item, index) =>
                h('div', { className: 'ghv-check-row', key: `${item.name}-${index}` },
                  h('span', {
                    className: `ghv-dot ${
                      item.state === 'success' ? 'ghv-dot-ok'
                        : item.state === 'failure' ? 'ghv-dot-bad'
                          : item.state === 'pending' ? 'ghv-dot-wait' : 'ghv-dot-none'
                    }`,
                  }),
                  item.url
                    ? h('a', { className: 'ghv-check-name ghv-link', href: safeUrl(item.url) || undefined, target: '_blank', rel: 'noreferrer' }, item.name)
                    : h('span', { className: 'ghv-check-name' }, item.name),
                  h('span', { className: 'ghv-check-state' }, item.state))))
          : null)
    }

    /** The GitHub glyph for a row's leading icon: PR (open/merged/closed/draft) or issue. */
    function RowGlyph({ item }) {
      const color = item.state === 'merged' ? 'var(--dsw-alias-brand-primary)'
        : item.state === 'closed' ? 'var(--dsw-alias-state-error-primary)'
          : item.draft ? 'var(--dsw-alias-state-idle-primary)'
            : 'var(--dsw-alias-state-success-primary)'
      if (item.isPull) {
        // Pull request: two nodes and a branch arc, matching GitHub's shape.
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
          fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round',
          style: { display: 'block', flex: 'none' },
        },
          h('circle', { cx: 4, cy: 3.2, r: 1.9 }),
          h('circle', { cx: 4, cy: 12.8, r: 1.9 }),
          h('circle', { cx: 12, cy: 12.8, r: 1.9 }),
          h('path', { d: 'M4 5.1v5.8' }),
          h('path', { d: 'M12 10.9V7.5a3 3 0 0 0-3-3H9' }))
      }
      // Issue: the one-node glyph.
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round',
        style: { display: 'block', flex: 'none' },
      },
        h('circle', { cx: 8, cy: 8, r: 5.4 }))
    }

    /**
     * The compact status strip under a row's title.
     *
     * Mirrors the badges the GitHub web UI shows on a list row, so the same
     * glance answers the same question: is it draft, are checks green, does it
     * have the required approvals, and who owns it.
     */
    function RowBadges({ item }) {
      const badges = []
      if (item.isPull) {
        if (item.draft) badges.push(h('span', { className: 'ghv-mini ghv-mini-idle', key: 'draft' }, 'Draft'))
        const checks = item.checks
        if (checks && checks.state !== 'none') {
          const dot = checks.state === 'passing' ? 'ghv-dot-ok' : checks.state === 'failing' ? 'ghv-dot-bad' : 'ghv-dot-wait'
          // A GraphQL list row carries the aggregate rollup only; the individual
          // check counts arrive with the detail page, so do not invent a number.
          const text = checks.aggregate
            ? (checks.state === 'passing' ? 'checks passing' : checks.state === 'failing' ? 'checks failing' : 'checks running')
            : checks.state === 'passing' ? `${checks.success} checks ok`
              : checks.state === 'failing' ? `${checks.failure} failing` : 'checks running'
          badges.push(h('span', { className: 'ghv-mini', key: 'checks', title: 'Status checks' },
            h('span', { className: `ghv-dot ${dot}` }), text))
        }
        const decision = item.reviewDecision
        if (decision === 'APPROVED') {
          badges.push(h('span', { className: 'ghv-mini ghv-mini-ok', key: 'review' }, 'Approved'))
        } else if (decision === 'CHANGES_REQUESTED') {
          badges.push(h('span', { className: 'ghv-mini ghv-mini-bad', key: 'review' }, 'Changes requested'))
        } else if (decision === 'REVIEW_REQUIRED') {
          badges.push(h('span', { className: 'ghv-mini ghv-mini-warn', key: 'review' }, 'Review required'))
        }
        if (item.mergeable === false) badges.push(h('span', { className: 'ghv-mini ghv-mini-bad', key: 'conflict' }, 'Conflicts'))
      }
      if (item.reviews > 0) badges.push(h('span', { className: 'ghv-mini', key: 'reviews' }, `${item.reviews} reviews`))
      if (item.comments > 0) badges.push(h('span', { className: 'ghv-mini', key: 'comments' }, `${item.comments} comments`))
      for (const person of (item.assignees ?? []).slice(0, 2)) {
        badges.push(h('span', { className: 'ghv-mini', key: `assignee-${person}`, title: `Assigned to ${person}` },
          h('span', { className: 'ghv-mini-avatar' }, person.slice(0, 1).toUpperCase()), person))
      }
      return badges.length > 0 ? h('div', { className: 'ghv-mini-row' }, badges) : null
    }

    /** One row in a list. */
    function ListRow({ item, onOpen }) {
      return h(
        'div',
        { className: 'ghv-item', onClick: () => onOpen(item.number), role: 'button', tabIndex: 0,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item.number) } } },
        h('span', { className: 'ghv-item-glyph' }, h(RowGlyph, { item })),
        h('div', { className: 'ghv-item-main' },
          h('div', { className: 'ghv-item-title' }, item.title),
          h('div', { className: 'ghv-item-meta' },
            `#${item.number} · ${item.state} · ${item.author || 'unknown'} · ${ago(item.updatedAt)}`),
          h(RowBadges, { item }),
          item.labels?.length ? h('div', { className: 'ghv-pills', style: { marginTop: 4 } }, item.labels.slice(0, 4).map((label) => h(LabelPill, { key: label.name, label }))) : null,
          item.linkedPulls?.length
            ? h('div', { className: 'ghv-linked' },
                'Linked: ',
                item.linkedPulls.map((pull) =>
                  h('span', { className: 'ghv-linked-pull', key: pull.number, title: pull.title },
                    h('svg', { viewBox: '0 0 16 16', width: 10, height: 10, 'aria-hidden': true, fill: 'none',
                      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', style: { display: 'inline-block', verticalAlign: '-1px', marginRight: 3 } },
                      h('circle', { cx: 4, cy: 3.2, r: 1.9 }), h('circle', { cx: 4, cy: 12.8, r: 1.9 }),
                      h('circle', { cx: 12, cy: 12.8, r: 1.9 }), h('path', { d: 'M4 5.1v5.8' }),
                      h('path', { d: 'M12 10.9V7.5a3 3 0 0 0-3-3H9' })),
                    `#${pull.number}${pull.draft ? ' (draft)' : ''}`)))
            : null),
      )
    }

    /**
     * The left sidebar row is a *main panel* switch: the shell renders one
     * `<button onClick={selectPanel(id)}>` per `sidebar.panellist` entry, so the
     * whole row — not just the icon — is that one button, and clicking it
     * selects the main panel registered under the same id.
     *
     * The panel therefore renders in the main column, full screen. An earlier
     * attempt registered a launcher here that opened a right-column tab and then
     * bounced the main column back to the Conversation; that made the row
     * unreliable (a click could land while no right-column seat was mounted) and
     * it left the row looking dead. Opening where the shell expects it is both
     * simpler and always responsive.
     */
    function GhViewMain(props) {
      return h('div', { className: 'ghv-main' }, h(GhViewPanel, props))
    }

    /**
     * The rail glyph for the sidebar row.
     *
     * `sidebar.panellist` only supplies the glyph; the row's button and its
     * click behaviour belong to the shell.
     */
    function GhViewNavIcon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' },
        },
        h('circle', { cx: 4, cy: 3.2, r: 1.9 }),
        h('circle', { cx: 4, cy: 12.8, r: 1.9 }),
        h('circle', { cx: 12, cy: 8, r: 1.9 }),
        h('path', { d: 'M4 5.1v5.8' }),
        h('path', { d: 'M4 3.2h4.2a3 3 0 0 1 3 3' }),
        h('path', { d: 'M4 12.8h4.2a3 3 0 0 0 3-3' }),
      )
    }

    /**
     * The loading surface for a list or a detail fetch.
     *
     * A skeleton rather than a bare word: the column is tall, so a single
     * "Loading…" line reads as an empty pane and makes a slow fetch look stuck.
     */
    function LoadingPane({ label, rows = 5 }) {
      return h(
        'div',
        { className: 'ghv-loading', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'ghv-loading-title' },
          h('span', { className: 'ghv-spin' }),
          h('span', null, `Loading ${label}…`)),
        Array.from({ length: rows }, (_, index) =>
          h('div', { className: 'ghv-skeleton', key: index },
            h('span', { className: 'ghv-skeleton-num' }),
            h('span', { className: 'ghv-skeleton-body' },
              h('span', { className: 'ghv-skeleton-line', style: { width: `${58 + ((index * 17) % 34)}%` } }),
              h('span', { className: 'ghv-skeleton-line ghv-skeleton-line-sm', style: { width: `${30 + ((index * 11) % 22)}%` } })))),
      )
    }

    /**
     * GitHub-style list filters: state, labels and a text query.
     *
     * These mirror the web UI's issue/PR query bar rather than inventing a
     * different vocabulary, so the same habits carry over.
     */
    function FilterBar({ tab, filter, setFilter, onApply, busy }) {
      const [draft, setDraft] = useState(filter)
      useEffect(() => { setDraft(filter) }, [filter])

      const commit = () => {
        setFilter(draft)
        onApply(draft)
      }

      return h(
        'div',
        { className: 'ghv-filters' },
        h('select', {
          className: 'ghv-input ghv-select ghv-filter-state',
          value: draft.state,
          'aria-label': 'State',
          onChange: (event) => {
            const next = { ...draft, state: event.target.value }
            setDraft(next)
            setFilter(next)
            onApply(next)
          },
        },
          h('option', { value: 'open' }, 'Open'),
          h('option', { value: 'closed' }, 'Closed'),
          h('option', { value: 'all' }, 'All')),
        // Newest-first is the only sane default, but "newest" is ambiguous: a
        // recently commented old issue is updated today and created years ago.
        h('select', {
          className: 'ghv-input ghv-select',
          value: draft.sort,
          'aria-label': 'Sort by',
          onChange: (event) => {
            const next = { ...draft, sort: event.target.value }
            setDraft(next)
            setFilter(next)
            onApply(next)
          },
        },
          h('option', { value: 'created' }, 'Newest created'),
          h('option', { value: 'updated' }, 'Recently updated')),
        h('input', {
          className: 'ghv-input',
          placeholder: 'labels: bug, help wanted',
          value: draft.labels,
          spellCheck: false,
          'aria-label': 'Labels',
          onChange: (event) => setDraft({ ...draft, labels: event.target.value }),
          onKeyDown: (event) => { if (event.key === 'Enter') commit() },
        }),
        h('input', {
          className: 'ghv-input',
          placeholder: 'Filter by title…',
          value: draft.search,
          spellCheck: false,
          'aria-label': 'Filter by title',
          onChange: (event) => setDraft({ ...draft, search: event.target.value }),
          onKeyDown: (event) => { if (event.key === 'Enter') commit() },
        }),
        h('button', { className: 'ghv-btn', onClick: commit, disabled: busy }, 'Apply'),
      )
    }

    /**
     * The panel itself.
     *
     * `props.useWorkspaces` is the slot's standard workspace hook, so the
     * repository default follows the workspace the user is looking at instead
     * of being a global preference. The panel is root-scoped and therefore has
     * no Session of its own; the chosen workspace path is what the Host half
     * reads git remotes from.
     */
    function GhViewPanel(props) {
      const useWorkspaces = props?.useWorkspaces
      // Identity selector: the hook only re-renders when the snapshot object
      // itself changes, so a fresh object from the store cannot spin renders.
      const workspaceSnapshot = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot) => snapshot) : undefined
      const workspaceItems = workspaceSnapshot?.items
      const workspaces = useMemo(
        () => (workspaceItems ?? []).map((workspace) => ({ path: workspace.path, title: workspace.title || workspace.path })),
        [workspaceItems],
      )

      /*
       * The directory "this session" means.
       *
       * The tab is session-scoped, so the shell hands us `sessionId`; the
       * workspace snapshot maps that session to its workspace path. This is
       * resolved on the client because the Host's panel route is root-scoped and
       * has no Session of its own — sending `dir=` empty and hoping the Host
       * guesses is what made this option answer with nothing.
       */
      const sessionId = props?.sessionId
      const sessionDir = useMemo(() => {
        if (sessionId === undefined) return undefined
        for (const workspace of workspaceItems ?? []) {
          if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.path
        }
        return undefined
      }, [sessionId, workspaceItems])

      const [repo, setRepo] = useState('')
      const [tab, setTab] = useState('repo')
      const [state, setState] = useState({ status: 'idle', repo: null, items: [], view: null, hasMore: false })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [health, setHealth] = useState(null)
      // The workspace directory the panel is scoped to; `''` is the sentinel for
      // "this session's directory", resolved to `sessionDir` at request time.
      const [activeDir, setActiveDir] = useState('')
      const [remotes, setRemotes] = useState(null)
      // GitHub-style list filters, mirroring the web UI's query bar.
      const [filter, setFilter] = useState({ state: 'open', labels: '', search: '', sort: 'created' })
      // The workspace/remote/query block collapses on its own once a repository
      // is detected — the panel's job is the list, not the picker.
      const [showQuery, setShowQuery] = useState(false)
      // Per-workspace repository memory, so switching back to a workspace
      // resumes the repository the user last chose there. Plain in-memory state:
      // this is a view preference, not something a Session log should record.
      const repoByDir = useRef({})
      // Monotonic id for the in-flight workspace load; see applyWorkspace.
      const workspaceToken = useRef(0)
      // Monotonic id for the in-flight list load. A slower list answer for an
      // older tab, repo or workspace must not overwrite a newer one.
      const listToken = useRef(0)
      // The same for a detail read: Back, a tab switch or a second jump must not
      // be overwritten by the answer to the first one.
      const viewToken = useRef(0)
      useEffect(() => {
        fetch(`${ROUTE}/health`)
          .then((response) => response.json())
          .then((body) => setHealth(body))
          .catch(() => setHealth(null))
      }, [])

      /**
       * Scope the panel to one workspace directory.
       *
       * `dir === ''` is the sentinel for "this session's directory" and resolves
       * to the path the workspace snapshot maps the tab's session to. The
       * remembered repository for that directory wins over the detected one, so
       * a user who picked `origin` instead of `upstream` does not have to pick it
       * again on every switch.
       */
      const applyWorkspace = useCallback(async (dir) => {
        setActiveDir(dir)
        // A list answer for the previous workspace must not land in this one.
        listToken.current += 1
        viewToken.current += 1
        setRemotes(null)
        setError(null)
        setBusy(true)
        // A switch invalidates any switch still in flight: two tabs (or a fast
        // user) can race, and the slower answer must not overwrite the newer one.
        const token = ++workspaceToken.current
        const stale = () => workspaceToken.current !== token
        // The request needs a real path; the sentinel only exists in UI state.
        const resolvedDir = dir === '' ? sessionDir : dir
        try {
          if (resolvedDir === undefined || resolvedDir === '') {
            // The session is not accounted to any workspace yet (or the snapshot
            // has not arrived). Say so instead of querying with no directory.
            setRemotes({ dir: null, origin: null, upstream: null, preferred: null, remotes: [] })
            setRepo('')
            setState({ status: 'idle', repo: null, items: [], view: null, hasMore: false })
            setShowQuery(true)
            setError('This session has no workspace directory yet. Pick a workspace above, or type owner/repo.')
            return
          }
          const found = await call('remotes', { dir: resolvedDir })
          if (stale()) return
          setRemotes(found)
          const remembered = repoByDir.current[resolvedDir]
          const target = remembered ?? found?.preferred
          if (target) {
            setRepo(target)
            setState((previous) => ({ ...previous, view: null, items: [], hasMore: false }))
            // A detected repository means the picker has done its job, so it
            // collapses without the user reaching for the toggle.
            setShowQuery(false)
            // Keep the tab the user is looking at: the first page must match the
            // Issues/Pull requests tab, not always the combined list.
            const kind = tab === 'prs' ? 'pr' : tab === 'issues' ? 'issue' : 'any'
            const [data, list] = await Promise.all([
              call('repo', { repo: target }),
              call('list', {
                repo: target,
                kind,
                state: filter.state,
                labels: filter.labels,
                search: filter.search,
                sort: filter.sort,
                limit: PAGE_SIZE,
              }),
            ])
            if (stale()) return
            setState({
              status: 'ready',
              repo: data,
              items: list.items ?? [],
              view: null,
              hasMore: (list.items ?? []).length >= PAGE_SIZE,
            })
          } else {
            // No GitHub remote here: clear the previous workspace's repository
            // rather than leave a stale one silently attached to this one, and
            // open the picker so the user can type one.
            setRepo('')
            setState({ status: 'idle', repo: null, items: [], view: null, hasMore: false })
            setShowQuery(true)
          }
        } catch (failure) {
          if (stale()) return
          // A directory with no GitHub remote is a normal state, not an error:
          // leave the field empty for manual entry instead of shouting.
          setRemotes({ dir: resolvedDir, origin: null, upstream: null, preferred: null, remotes: [] })
          setRepo('')
          setState({ status: 'idle', repo: null, items: [], view: null, hasMore: false })
          setShowQuery(true)
          setError(null)
          void failure
        } finally {
          setBusy(false)
        }
      }, [sessionDir, tab, filter])

      /*
       * Adopt the session's own directory once it is known.
       *
       * The workspace snapshot arrives asynchronously, so this waits for
       * `sessionDir` instead of firing once with an unresolved path — that was
       * the other half of "This session's directory does nothing".
       */
      const adopted = useRef(false)
      useEffect(() => {
        if (adopted.current || sessionDir === undefined) return
        adopted.current = true
        void applyWorkspace('')
      }, [sessionDir, applyWorkspace])

      /**
       * Load the overview and the first page of a list for one tab.
       *
       * `kind` is passed in rather than read from the `tab` state: a state write
       * inside this call is not visible to a callback created in the same render,
       * so reading it would mix the previous tab's rows into the new tab.
       */
      const loadRepo = useCallback(async (value, kind = 'any') => {
        // Switching repositories invalidates a list answer for the old one.
        const token = ++listToken.current
        viewToken.current += 1
        const stale = () => listToken.current !== token
        const data = await call('repo', { repo: value })
        if (stale()) return
        setState({ status: 'ready', repo: data, items: [], view: null })
        if (kind === 'any') return
        const list = await call('list', {
          repo: data.fullName,
          kind,
          state: filter.state,
          labels: filter.labels,
          search: filter.search,
          sort: filter.sort,
          limit: PAGE_SIZE,
        })
        if (stale()) return
        setState((previous) => ({ ...previous, items: list.items ?? [], hasMore: (list.items ?? []).length >= PAGE_SIZE }))
      }, [filter])

      /** Open one issue or pull request by number. */
      const openRef = useCallback(async (text) => {
        const token = ++viewToken.current
        const stale = () => viewToken.current !== token
        setBusy(true)
        setError(null)
        try {
          const data = await call('view', { repo: state.repo?.fullName, ref: text })
          if (stale()) return
          setState((previous) => ({ ...previous, status: 'ready', view: data }))
        } catch (failure) {
          if (stale()) return
          setError(failure.message)
        } finally {
          if (!stale()) setBusy(false)
        }
      }, [state.repo])

      /**
       * Load one page of a list.
       *
       * `kind` is the tab's kind, always passed explicitly for the same reason as
       * above. `append` turns the call into "load more" so the existing rows stay
       * on screen instead of being replaced by the next page.
       */
      const loadList = useCallback(async (kind, { append = false, filter: filterOverride } = {}) => {
        if (!state.repo) return
        // Any list start invalidates the answers still in flight: a tab switch
        // or a "load more" must not be rewritten by the previous request.
        const token = ++listToken.current
        viewToken.current += 1
        const stale = () => listToken.current !== token
        const activeFilter = filterOverride ?? filter
        setBusy(true)
        setError(null)
        const offset = append ? (state.items?.length ?? 0) : 0
        const query = {
          repo: state.repo.fullName,
          kind,
          state: activeFilter.state,
          labels: activeFilter.labels,
          search: activeFilter.search,
          sort: activeFilter.sort,
          limit: PAGE_SIZE,
          offset,
        }
        try {
          /*
           * Two passes, because the badges are expensive: the row lookups add a
           * request or two per pull request, and 20 rows of them is what made a
           * list take four seconds. The first pass returns rows only so the list
           * paints at once; the second fills the badges in behind it.
           */
          const quick = await call('list', { ...query, badges: '0' })
          if (stale()) return
          const rows = quick.items ?? []
          if (append) {
            setState((previous) => ({
              ...previous,
              view: null,
              items: [...(previous.items ?? []), ...rows],
              hasMore: rows.length >= PAGE_SIZE,
            }))
          } else {
            setState((previous) => ({
              ...previous,
              view: null,
              items: rows,
              hasMore: rows.length >= PAGE_SIZE,
            }))
          }
          setBusy(false)

          // Pull-request rows from GraphQL already carry their badge state; a
          // second pass would be a second round trip for the same answer. Issue
          // rows arrive bare, so they still need it.
          const needsBadgePass = rows.some((row) => row.checks === undefined)
          if (!needsBadgePass) return

          const full = await call('list', query)
          if (stale()) return
          const enriched = full.items ?? []
          if (enriched.length === 0) return
          // Merge by number: the second pass may race a tab switch or a reload,
          // and swapping the whole array would fight whatever ran last. The
          // token above already drops an answer for an older query.
          setState((previous) => {
            const byNumber = new Map(enriched.map((item) => [item.number, item]))
            return {
              ...previous,
              items: (previous.items ?? []).map((item) => byNumber.get(item.number) ?? item),
            }
          })
        } catch (failure) {
          if (stale()) return
          setError(failure.message)
          setBusy(false)
        }
      }, [state.repo, state.items, filter])

      /**
       * Switch tabs.
       *
       * A detail view belongs to the tab that opened it: leaving the tab must
       * drop that view, otherwise clicking "Pull requests" while an issue is open
       * either keeps showing the issue or briefly paints issue rows under the PR
       * tab — the "mixed list" symptom.
       */
      const selectTab = useCallback((next) => {
        // A list answer still in flight belongs to the tab being left.
        listToken.current += 1
        viewToken.current += 1
        setTab(next)
        // The left tab's request may never clear its own spinner; this switch
        // owns the UI now, and a list tab sets busy again when it starts.
        setBusy(false)
        setState((previous) => ({ ...previous, view: null }))
        if (next === 'repo') return
        void loadList(next === 'prs' ? 'pr' : 'issue')
      }, [loadList])

      /** Leave this tab, the same way any other right-column tab closes. */
      /**
       * Leave the panel for the Conversation.
       *
       * This surface can be shown two ways — as a main panel (the sidebar row)
       * or as a right-column tab (the guide capsule) — so the close control
       * tries whichever is actually showing and never assumes one.
       */
      const closePanel = useCallback(() => {
        try {
          const layout = layoutRef.current
          if (layout !== undefined) layout.selectPanel(null)
        } catch {
          // Shell-owned navigation must never break rendering.
        }
        try {
          const service = sidebarRightRef.current
          if (service === undefined) return
          const active = service.active()
          if (active?.kind === TAB_KIND) service.close(active.id)
        } catch {
          // Nothing to close in the right column.
        }
      }, [])

      const body = error
        ? h('div', { className: 'ghv-error' }, error)
        : state.view
          ? state.view.kind === 'pr' ? h(PullView, { data: state.view }) : h(IssueView, { data: state.view })
          : state.repo
            ? tab === 'repo'
              ? h(RepoView, { data: state.repo })
              : busy && state.items.length === 0
                ? h(LoadingPane, { label: tab === 'prs' ? 'pull requests' : 'issues' })
                : state.items.length
                  ? h('div', null,
                      busy ? h('div', { className: 'ghv-inline-busy' }, h('span', { className: 'ghv-spin' }), 'Loading…') : null,
                      state.items.map((item) => h(ListRow, {
                        key: `${item.repository ?? ''}${item.number}`,
                        item,
                        // Target the row's own repository: rows fetched for an
                        // earlier repo must never open their number elsewhere.
                        onOpen: () => void openRef(item.repository ? `${item.repository}#${item.number}` : `#${item.number}`),
                      })))
                  : h('div', { className: 'ghv-empty' }, 'Nothing matched these filters.')
            : busy
              ? h(LoadingPane, { label: 'repository' })
              : h('div', { className: 'ghv-empty' },
                  workspaces.length > 0
                    ? 'This workspace’s git remotes have no GitHub repository. Type owner/repo above.'
                    : 'Enter a repository as owner/repo, then jump to #123.')

      return h(
        'div',
        { className: 'ghv-page' },
        h('style', null, STYLES),
        h('div', { className: 'ghv-head' },
          h('span', { className: 'ghv-title' },
            state.repo ? state.repo.fullName : 'GitHub'),
          h('span', { className: 'ghv-spacer' }),
          busy ? h('span', { className: 'ghv-spin', role: 'status', 'aria-label': 'Loading' }) : null,
          // A refresh control, because the reads above are cached for a few
          // seconds and a reader who just pushed wants to see it now.
          state.repo
            ? h('button', {
                className: 'ghv-icon',
                title: 'Refresh',
                onClick: () => {
                  invalidateReads()
                  if (state.view) void openRef(`${state.view.repo}#${state.view.number}`)
                  else void loadRepo(state.repo.fullName, tab === 'prs' ? 'pr' : tab === 'issues' ? 'issue' : 'any')
                },
              }, '⟳')
            : null,
          // Once a repository is open the query block is mostly noise, so it
          // collapses to this one control instead of occupying four rows.
          state.repo
            ? h('button', {
                className: 'ghv-icon',
                title: showQuery ? 'Hide the repository and search controls' : 'Change repository or jump to #123',
                'aria-expanded': showQuery,
                onClick: () => setShowQuery((value) => !value),
              }, showQuery ? '⌃' : '⌄')
            : null,
          h('button', { className: 'ghv-icon', title: 'Back to conversation', onClick: closePanel }, '×')),
        state.repo && !showQuery
          ? h('div', { className: 'ghv-current' },
              remotes?.upstream && remotes?.origin && remotes.preferred === remotes.upstream
                ? h('span', { className: 'ghv-src' }, 'upstream')
                : null,
              h('span', { className: 'ghv-spacer' }),
              h(JumpBar, { onSubmit: (value) => void openRef(value), busy, compact: true }))
          : h('div', null,
              h(LookupBar, {
                workspaces,
                activeDir,
                remotes,
                repoText: repo,
                setRepoText: setRepo,
                onWorkspace: (dir) => { void applyWorkspace(dir) },
                onRemote: async (value) => {
                  setRepo(value)
                  // Remember the choice for this workspace so returning to it
                  // resumes the same repository instead of the detected default.
                  if (activeDir !== '') repoByDir.current[activeDir] = value
                  await loadRepo(value, tab === 'prs' ? 'pr' : tab === 'issues' ? 'issue' : 'any')
                },
                onRepo: async (value) => {
                  setRepo(value)
                  if (activeDir !== '') repoByDir.current[activeDir] = value
                  await loadRepo(value, tab === 'prs' ? 'pr' : tab === 'issues' ? 'issue' : 'any')
                },
                onError: setError,
                busy,
                setBusy,
              }),
              h(JumpBar, { onSubmit: (value) => void openRef(value), busy })),
        /*
         * The tab row doubles as the detail view's way out: "← Back" replaces the
         * tabs while a detail is open, which is where the reader's eye already is
         * and which keeps the tab strip from lying about which list is showing.
         */
        state.view
          ? h('div', { className: 'ghv-tabs' },
              h('button', {
                className: 'ghv-back',
                title: 'Back to the list',
                onClick: () => setState((previous) => ({ ...previous, view: null })),
              }, '← Back'),
              h('span', { className: 'ghv-tab-crumb' },
                tab === 'prs' ? 'Pull requests' : tab === 'issues' ? 'Issues' : 'Overview'))
          : h('div', { className: 'ghv-tabs', role: 'tablist' },
              ['repo', 'issues', 'prs'].map((key) =>
                h('button', {
                  key, className: 'ghv-tab', role: 'tab', 'aria-selected': tab === key,
                  onClick: () => selectTab(key),
                }, key === 'repo' ? 'Overview' : key === 'issues' ? 'Issues' : 'Pull requests'))),
        state.view === null && tab !== 'repo'
          ? h(FilterBar, {
              tab,
              filter,
              setFilter,
              onApply: (next) => {
                if (!state.repo) return
                // Route the filter through the guarded loader, so a slow answer
                // for the previous filter cannot land under a newer one.
                setFilter(next)
                void loadList(tab === 'prs' ? 'pr' : 'issue', { filter: next })
              },
              busy,
            })
          : null,
        h('div', { className: 'ghv-body' }, body),
        // A short page is the only reliable "no more rows" signal, so the control
        // appears while the last page came back full.
        state.view === null && tab !== 'repo' && state.items.length > 0 && state.hasMore
          ? h('div', { className: 'ghv-more-row' },
              h('button', {
                className: 'ghv-btn',
                disabled: busy,
                onClick: () => void loadList(tab === 'prs' ? 'pr' : 'issue', { append: true }),
              }, busy ? 'Loading…' : 'Load more'))
          : null,
        h('div', { className: 'ghv-foot' },
          h('span', null, health ? `${health.source === 'gh' ? 'gh CLI' : 'REST API'}${health.canRender ? ' · cards on' : ' · cards off'}` : 'connecting…'),
          h('span', null, 'gh_repo · gh_list · gh_view · gh_search')),
      )
    }

    /**
     * The conversation card for one gh-view tool call.
     *
     * The shipped image card is name-gated to `read_image`, so an image-bearing
     * tool of our own would otherwise fall back to a generic row that prints the
     * attachment JSON. Registering our own `tool.call.toolview` entries keeps
     * the picture in the transcript. The URL comes from the session-authorized
     * `loadImage` owner prop, never from a hand-built path.
     */
    function GhViewToolCard(props) {
      const { phase, block, loadImage, toolName } = props
      const [src, setSrc] = useState(null)
      const [broken, setBroken] = useState(false)

      /** The image block of a settled result, if this call produced one. */
      const attachment = useMemo(() => {
        if (phase !== 'result' || !block || block.isError) return null
        const content = Array.isArray(block.content) ? block.content : []
        const hit = content.find((part) => part && part.type === 'image' && part.attachment)
        return hit ? hit.attachment : null
      }, [phase, block])

      /** The text the tool returned, shown as the card's caption. */
      const caption = useMemo(() => {
        if (phase !== 'result' || !block) return ''
        const content = Array.isArray(block.content) ? block.content : []
        const text = content.find((part) => part && part.type === 'text')
        return text?.text ?? ''
      }, [phase, block])

      useEffect(() => {
        let live = true
        setBroken(false)
        setSrc(null)
        if (attachment === null || typeof loadImage !== 'function') return () => { live = false }
        setSrc(loadImage.peek?.(attachment) ?? null)
        Promise.resolve(loadImage(attachment))
          .then((url) => { if (live) setSrc(url) })
          .catch(() => { if (live) setBroken(true) })
        return () => { live = false }
      }, [attachment, loadImage])

      const label = toolName.replace(/^gh_/, '')
      const headline = cap(toolName)

      if (phase === 'preparing' || phase === 'start') {
        return h(
          'div',
          { className: 'ghx-card' },
          h('style', null, STYLES),
          h('div', { className: 'ghx-head' }, h('span', { className: 'ghx-name' }, headline), h('span', { className: 'ghx-muted' }, 'fetching…')),
        )
      }

      if (block?.isError) {
        const message = caption || 'The lookup failed.'
        return h(
          'div',
          { className: 'ghx-card' },
          h('style', null, STYLES),
          h('div', { className: 'ghx-head' }, h('span', { className: 'ghx-name' }, headline)),
          h('div', { className: 'ghx-error' }, message),
        )
      }

      return h(
        'div',
        { className: 'ghx-card' },
        h('style', null, STYLES),
        h('div', { className: 'ghx-head' },
          h('span', { className: 'ghx-name' }, headline),
          h('span', { className: 'ghx-muted' }, "GitHub view")),
        caption ? h('div', { className: 'ghx-caption' }, firstLines(caption, 3)) : null,
        attachment !== null
          ? broken
            ? h('div', { className: 'ghx-muted', style: { marginTop: 6 } }, 'The card image could not be loaded.')
            : src === null
              ? h('div', { className: 'ghx-muted', style: { marginTop: 6 } }, 'Loading card…')
              : h('img', { className: 'ghx-image', src, alt: `${label} card` })
          : null,
      )
    }

    /** Turn `gh_view` into `GH view` for the card header. */
    function cap(toolName) {
      const bare = String(toolName ?? '').replace(/^gh_/, '')
      return `gh ${bare}`
    }

    /** First few lines of a summary, for the caption. */
    function firstLines(text, count) {
      return String(text ?? '').split('\n').slice(0, count).join('\n')
    }

    /*
     * Declared dependencies, so Cordis activates this plugin only once they are
     * live.
     *
     * `sidebarRight` and `sidebarRightTabs` matter here: the right column's
     * plugin publishes them from its own effect, so declaring them in this
     * module-level `inject` is what makes Cordis call `apply` afterwards — the
     * same way every shipped right-column plugin does it
     * (`inject = ['slots','locale','sidebarRight','sidebarRightTabs',…]`).
     * Without the declaration `apply` runs too early, every lookup answers
     * undefined, and the tab type silently never registers.
     */
    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout'],
      apply(ctx) {
        // Declared in this module's `inject`, so both are live by now.
        sidebarRightRef.current = ctx.sidebarRight
        layoutRef.current = ctx.layout
        ctx.effect(() => () => {
          sidebarRightRef.current = undefined
          layoutRef.current = undefined
        }, 'gh-view: service refs')

        /*
         * Stage one of a tab type: declare the kind and its guide capsule.
         *
         * The body below registers into `sidebar.right.pane.tab`, which is a
         * slot rather than a service, so the two halves are independent: losing
         * the registry would cost only the guide capsule.
         */
        let registered = false
        const registerTabType = (tabs) => {
          if (registered || tabs === undefined) return
          registered = true
          try {
            tabs.register({
              id: TAB_KIND,
              kind: TAB_KIND,
              title: () => 'GitHub',
              // A guide capsule advertises the page type on the column's start
              // page, beside Workspace files, Code review and Browser.
              guide: [{
                id: 'gh-view.open',
                order: 40,
                title: () => 'GitHub issue / PR',
                description: () => 'Browse a repository’s issues and pull requests by #number.',
              }],
            })
          } catch (error) {
            // A stale registration from a previous load is not fatal.
            ctx.logger?.warn?.(`gh-view: right-column tab type not registered: ${error?.message ?? error}`)
          }
        }

        registerTabType(ctx.sidebarRightTabs)

        // A failed registration is worth one line: the tab would otherwise be
        // silently missing, and the banner is the only place this build reports it.
        if (!registered) {
          console.warn('[gh-view] the right-column tab type did not register; the panel still opens from the sidebar row.')
        }

        // Late arrival is still possible if the column is remounted; take it then.
        ctx.effect(() => {
          let tries = 0
          const timer = setInterval(() => {
            tries += 1
            registerTabType(ctx.sidebarRightTabs)
            if (registered || tries >= 40) clearInterval(timer)
          }, 500)
          return () => clearInterval(timer)
        }, 'gh-view: deferred tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_KIND,
        }, GhViewPanel))

        /*
         * The guide card's renderer.
         *
         * A tab type's `guide` array contributes the *data* for a start-page
         * capsule; this slot supplies the card that draws it, keyed by the same
         * type id. The shipped types register both, and a type without this card
         * is dispatched to the owner's generic fallback.
         *
         * The card owns its own click: this slot's owner props carry only
         * `entryId`, `kind`, `title` and `description` — no pick callback — so a
         * card that merely draws text is inert. It opens the tab through the same
         * navigation service every other entry point uses.
         *
         * Styles are inline on purpose: this card renders on the start page,
         * outside the panel component, where the panel's <style> block is not in
         * the tree.
         */
        ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
          name: 'sidebar.right.tab.guide.entry',
          key: TAB_KIND,
        }, ({ title, description, kind: entryKind }) => {
          const open = () => {
            try {
              sidebarRightRef.current?.openTab(entryKind ?? TAB_KIND)
            } catch {
              // The right column acts on the on-screen session; with none (or the
              // column unavailable) fall back to the full-screen panel so a click
              // always leads somewhere.
              try {
                layoutRef.current?.selectPanel?.(PANEL_ID)
              } catch {
                // Nothing else to try.
              }
            }
          }
          /*
           * Mirrors the shell's own entry box: a custom card replaces that box
           * rather than nesting inside it, so it has to draw the capsule itself
           * or it renders as bare text among bordered rows.
           */
          return h('button', {
            type: 'button',
            title: title ?? 'GitHub issue / PR',
            'data-sidebar-right-guide-entry': entryKind ?? TAB_KIND,
            onClick: open,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              }
            },
            style: {
              boxSizing: 'border-box', width: 380, maxWidth: '100%', minHeight: 56,
              display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px',
              textAlign: 'left', color: 'var(--dsw-alias-label-primary)', font: 'inherit',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: 'var(--dsl-guide-entry-radius, 14px)', cursor: 'pointer',
            },
            onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)' },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-1)' },
          },
            h('span', {
              style: {
                width: 26, height: 26, flex: 'none', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, h(GhViewNavIcon, { size: description === undefined ? 22 : 26 })),
            h('span', {
              style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 3, minWidth: 0 },
            },
              h('span', {
                style: {
                  fontSize: 14, lineHeight: 1.4, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                },
              }, title ?? 'GitHub issue / PR'),
              description !== undefined
                ? h('span', {
                    style: {
                      fontSize: 11, lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden',
                      textOverflow: 'ellipsis', color: 'var(--dsw-alias-label-secondary)',
                    },
                  }, description)
                : null))
        }))

        // The way in: the sidebar row selects the main panel under this same id,
        // so the panel renders full screen in the main column.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: 'GitHub',
        }, GhViewNavIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, GhViewMain))

        // One tool card per tool, so the rendered PNG appears in the transcript.
        for (const toolName of ['gh_repo', 'gh_list', 'gh_view', 'gh_search']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolName,
          }, GhViewToolCard))
        }
      },
    }
  },
})
