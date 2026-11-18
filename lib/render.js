/**
 * Render a GitHub summary as a PNG card.
 *
 * The card is authored as HTML and rasterized by a headless Chromium already
 * present on the machine (Edge, or Chrome). Doing it this way keeps the whole
 * text pipeline — CJK wrapping, font fallback, ellipsis, emoji — identical to a
 * browser, which is exactly what the card has to look like, and avoids shipping
 * a font/rasterizer stack with the plugin.
 *
 * When no browser is found, `renderCard` reports that in its error and the
 * caller falls back to the text summary, so the panel and the tools still work.
 */

import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

/** Absolute candidate browser paths, most preferred first, per platform. */
function browserCandidates() {
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)
    return [
      ...roots.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/** Find the first usable browser, or undefined when none exists. */
export async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for insertion into the card markup. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

/** Compact a count the way GitHub does: 46770 -> 46.8k. */
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

/** A date as YYYY-MM-DD. */
function day(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/**
 * Pick readable text colors for a GitHub label, whose color is a bare hex
 * without a leading `#`.
 */
function labelStyle(color) {
  const hex = String(color ?? '').replace(/[^0-9a-f]/gi, '').padEnd(6, '6').slice(0, 6)
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  const dark = luminance > 0.6
  return `background:#${hex};color:${dark ? '#0d1117' : '#ffffff'};border-color:rgba(255,255,255,0.16)`
}

/**
 * A short plain-text excerpt of one comment, for the reply strip.
 * @param {string} text raw markdown
 */
function replyText(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s{0,3}(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s*/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '• ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
}

/** One label pill. */
function labelPill(label) {
  if (!label?.name) return ''
  if (!label.color) return `<span class="pill pill-plain">${esc(label.name)}</span>`
  return `<span class="pill" style="${labelStyle(label.color)}">${esc(label.name)}</span>`
}

/** Small state chip shared by issues and PRs. */
function stateChip(state) {
  const table = {
    open: { text: 'Open', cls: 'is-open' },
    closed: { text: 'Closed', cls: 'is-closed' },
    merged: { text: 'Merged', cls: 'is-merged' },
    draft: { text: 'Draft', cls: 'is-draft' },
  }
  const entry = table[state] ?? table.open
  return `<span class="chip ${entry.cls}">${entry.text}</span>`
}

/** Image URL for a card: absolute http(s) or an inline image only. */
function imageUrl(value) {
  const raw = String(value ?? '').trim()
  return /^(?:https?:\/\/|data:image\/)/i.test(raw) ? esc(raw) : ''
}

/** Avatar with an initial fallback, so a blocked image never breaks the card. */
function avatar(user) {
  const initial = esc(String(user?.login ?? '?').slice(0, 1).toUpperCase())
  const source = imageUrl(user?.avatar)
  return `<span class="avatar"><span class="avatar-text">${initial}</span>${
    source !== '' ? `<img src="${source}" alt="" referrerpolicy="no-referrer">` : ''
  }</span>`
}

/**
 * Render a markdown body as plain, readable lines (no HTML passthrough).
 *
 * The card is a summary, not a markdown renderer: headings lose their `#`,
 * bullets become `•`, fenced code is kept verbatim but unbundled, and inline
 * markers (`**`, `` ` ``, links) are reduced to their visible text so a card
 * never shows raw markup.
 * @param {string} text raw markdown body
 * @param {number} maxLines how many lines the excerpt may occupy
 */
function bodyText(text, maxLines = 14) {
  let fenced = false
  const lines = String(text ?? '')
    .split('\n')
    .map((raw) => {
      if (/^\s{0,3}(```|~~~)/.test(raw)) {
        fenced = !fenced
        return ''
      }
      if (fenced) return raw.replace(/\t/g, '  ')
      return raw
        // Images and links: keep the visible label only.
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Emphasis and inline code markers.
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(/`([^`]*)`/g, '$1')
        // Headings, blockquote markers, list bullets, task boxes.
        .replace(/^\s{0,3}#{1,6}\s*/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '• ')
        .replace(/^\s*[-*+]\s+/, '• ')
        .replace(/^\s*(\d+)\.\s+/, '$1. ')
        // Table pipes read as noise in prose.
        .replace(/^\s*\|(.*)\|\s*$/, (_match, inner) => inner.split('|').map((cell) => cell.trim()).join(' · '))
        .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/, '')
        .trimEnd()
    })
  const out = []
  for (const line of lines) {
    if (line === '' && out.at(-1) === '') continue
    out.push(line)
  }
  const trimmed = out[0] === '' ? out.slice(1) : out
  return trimmed.slice(0, maxLines).map((line) => esc(line)).join('<br>')
}

/** The shared card chrome: dark GitHub-like surface, 2x safe typography. */
function shell({ title, subtitle, accent = '#2f81f7', body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --line: #30363d;
    --text: #e6edf3; --muted: #8b949e; --faint: #6e7681;
    --green: #3fb950; --red: #f85149; --purple: #a371f7; --yellow: #d29922;
    --accent: ${accent};
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body {
    font: 14px/1.55 "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB",
          "Noto Sans CJK SC", system-ui, -apple-system, sans-serif;
    color: var(--text); -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 760px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 14px; overflow: hidden;
  }
  .head {
    padding: 18px 22px 14px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, rgba(47,129,247,0.10), rgba(47,129,247,0) 92%);
    border-left: 3px solid var(--accent);
  }
  .eyebrow { font-size: 12px; color: var(--muted); letter-spacing: .04em; text-transform: uppercase; }
  .eyebrow .sep { opacity: .5; margin: 0 6px; }
  h1 { font-size: 20px; line-height: 1.35; margin: 6px 0 0; font-weight: 650; letter-spacing: -.01em; }
  .sub { margin-top: 5px; font-size: 13px; color: var(--muted); }
  .body { padding: 16px 22px 18px; }
  .row { display: flex; gap: 18px; align-items: baseline; }
  .stats { display: flex; gap: 22px; flex-wrap: wrap; }
  .stat .n { font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
  .stat .l { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    display: inline-block; font-size: 11px; font-weight: 600; line-height: 18px;
    padding: 0 9px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap;
  }
  .pill-plain { background: #21262d; color: var(--muted); border-color: var(--line); }
  .chip {
    display: inline-block; font-size: 11.5px; font-weight: 650; line-height: 20px;
    padding: 0 10px; border-radius: 999px; border: 1px solid transparent;
  }
  .is-open { background: rgba(63,185,80,.14); color: var(--green); border-color: rgba(63,185,80,.4); }
  .is-closed { background: rgba(248,81,73,.14); color: var(--red); border-color: rgba(248,81,73,.4); }
  .is-merged { background: rgba(163,113,247,.16); color: var(--purple); border-color: rgba(163,113,247,.45); }
  .is-draft { background: rgba(139,148,158,.14); color: var(--muted); border-color: var(--line); }
  .avatar {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%; overflow: hidden;
    background: #30363d; color: var(--text); font-size: 11px; font-weight: 700;
    vertical-align: -5px; margin-right: 6px; flex: none;
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .who { display: inline-flex; align-items: center; font-size: 13px; color: var(--muted); }
  .who b { color: var(--text); font-weight: 600; }
  /* The inline-flex row above collapses the gap after a bold display name. */
  .who b::after { content: ""; display: inline-block; width: 6px; }
  .box {
    margin-top: 14px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 14px; font-size: 13.5px; color: #c9d1d9;
  }
  .box .more { margin-top: 6px; font-size: 11.5px; color: var(--faint); }
  .kv { margin-top: 12px; display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; }
  .kv dt { color: var(--faint); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
  .kv dd { margin: 0; color: var(--text); }
  .checks { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .check {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot-ok { background: var(--green); } .dot-bad { background: var(--red); }
  .dot-wait { background: var(--yellow); } .dot-none { background: var(--faint); }
  .plus { color: var(--green); font-weight: 650; }
  .minus { color: var(--red); font-weight: 650; }
  .scale { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #21262d; min-width: 160px; flex: 1; }
  .bar i { display: block; height: 100%; }
  .reply { margin-top: 10px; padding-left: 10px; border-left: 2px solid var(--line); font-size: 12.5px; color: var(--muted); }
  .reply .who { font-size: 12px; margin-bottom: 2px; }
  .foot {
    display: flex; justify-content: space-between; gap: 12px; align-items: center;
    padding: 10px 22px; border-top: 1px solid var(--line); background: #0b0f14;
    font-size: 11.5px; color: var(--faint);
  }
  .foot code { color: var(--muted); font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
</style></head>
<body><div class="card">
  <header class="head">
    <div class="eyebrow">${subtitle.left}</div>
    <h1>${title}</h1>
    ${subtitle.right ? `<div class="sub">${subtitle.right}</div>` : ''}
  </header>
  <div class="body">${body}</div>
  <div class="foot"><span>${subtitle.footLeft}</span><code>${esc(subtitle.footRight)}</code></div>
</div></body></html>`
}

/** The repository overview card. */
export function repoCard(repo) {
  const created = repo.createdAt ? `Created ${day(repo.createdAt)}` : ''
  const pushed = repo.pushedAt ? `last push ${ago(repo.pushedAt)}` : ''
  const stats = [
    ['Stars', compact(repo.stars)],
    ['Forks', compact(repo.forks)],
    ['Watching', compact(repo.watchers)],
    ['Open issues', repo.openIssues === null ? '—' : compact(repo.openIssues)],
    ['Open PRs', repo.openPulls === null ? '—' : compact(repo.openPulls)],
  ]
    .map(([label, value]) => `<div class="stat"><div class="n">${esc(value)}</div><div class="l">${label}</div></div>`)
    .join('')

  const topics = (repo.topics ?? []).slice(0, 8).map((topic) => `<span class="pill pill-plain">${esc(topic)}</span>`).join('')
  const facts = [
    repo.language ? ['Language', esc(repo.language)] : null,
    repo.license ? ['License', esc(repo.license)] : null,
    repo.defaultBranch ? ['Default branch', `<code>${esc(repo.defaultBranch)}</code>`] : null,
    repo.latestRelease ? ['Latest release', `<code>${esc(repo.latestRelease.tag)}</code>${repo.latestRelease.at ? ` · ${esc(ago(repo.latestRelease.at))}` : ''}`] : null,
    repo.homepage ? ['Homepage', esc(repo.homepage)] : null,
    [created, pushed].filter(Boolean).length ? ['Timeline', [created, pushed].filter(Boolean).map(esc).join(' · ')] : null,
  ].filter(Boolean)

  const body = `
    ${repo.description ? `<div class="box">${esc(repo.description)}</div>` : ''}
    <div style="margin-top:16px"><div class="stats">${stats}</div></div>
    ${facts.length ? `<dl class="kv">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${topics ? `<div class="pills" style="margin-top:14px">${topics}</div>` : ''}
    ${repo.archived ? '<div class="checks"><span class="check"><span class="dot dot-bad"></span>Archived</span></div>' : ''}
  `

  return shell({
    title: esc(repo.fullName),
    subtitle: {
      left: `Repository overview${repo.isPrivate ? ' <span class="sep">·</span> private' : ''}${repo.isFork ? ' <span class="sep">·</span> fork' : ''}`,
      right: '',
      footLeft: `<span class="who">${esc(repo.owner ?? '')}</span>`,
      footRight: repo.url,
    },
    body,
  })
}

/** The issue card. */
export function issueCard(issue) {
  const labels = (issue.labels ?? []).map(labelPill).join('')
  const body = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      ${stateChip(issue.state)}
      <span class="who">${avatar(issue.author)}<b>${esc(issue.author.login)}</b></span>
      <span style="color:var(--faint);font-size:12.5px">opened ${esc(ago(issue.createdAt))} · ${compact(issue.comments)} comments</span>
    </div>
    ${labels ? `<div class="pills" style="margin-top:12px">${labels}</div>` : ''}
    ${issue.body ? `<div class="box">${bodyText(issue.body)}${
      issue.bodyTruncated ? '<div class="more">Body truncated — open the link for the rest.</div>' : ''
    }</div>` : '<div class="box" style="color:var(--faint)">No description.</div>'}
    ${
      (issue.replies ?? []).length
        ? issue.replies
            .map(
              (reply) => `<div class="reply"><div class="who">${avatar(reply.author)}<b>${esc(reply.author.login)}</b>
                <span style="color:var(--faint)"> · ${esc(ago(reply.createdAt))}</span></div>${esc(replyText(reply.body))}</div>`,
            )
            .join('')
        : ''
    }
  `
  return shell({
    title: `<span style="color:var(--faint);font-weight:600">#${esc(issue.number)}</span> ${esc(issue.title)}`,
    subtitle: {
      left: `Issue${issue.milestone ? ` <span class="sep">·</span> milestone ${esc(issue.milestone)}` : ''}${
        (issue.assignees ?? []).length ? ` <span class="sep">·</span> ${esc(issue.assignees.join(', '))}` : ''
      }`,
      right: esc(issue.repo),
      footLeft: `${issue.state === 'open' ? 'Open' : 'Closed'}${
        issue.stateReason ? ` as ${esc(issue.stateReason)}` : ''
      }${issue.isLocked ? ' · locked' : ''} · updated ${esc(ago(issue.updatedAt))}`,
      footRight: issue.url,
    },
    body,
  })
}

/** The pull request card: size, checks, reviews. */
export function pullCard(pull) {
  const labels = (pull.labels ?? []).map(labelPill).join('')
  const additions = Number(pull.additions)
  const deletions = Number(pull.deletions)
  const total = (Number.isFinite(additions) ? additions : 0) + (Number.isFinite(deletions) ? deletions : 0)
  const plusPct = total === 0 ? 0 : Math.round(((Number.isFinite(additions) ? additions : 0) / total) * 100)
  const checks = pull.checks ?? { state: 'none', success: 0, failure: 0, pending: 0, total: 0, failing: [] }
  const dot = { passing: 'dot-ok', failing: 'dot-bad', pending: 'dot-wait' }[checks.state] ?? 'dot-none'
  const checkLabel = {
    passing: `Checks passing (${esc(checks.success)})`,
    failing: `Checks failing (${esc(checks.failure)})`,
    pending: `Checks running (${esc(checks.pending)})`,
    none: 'No checks',
  }[checks.state]

  const approved = pull.approvals?.length ?? 0
  const blocked = pull.changesRequested?.length ?? 0
  const reviewLabel = approved > 0 && blocked === 0
    ? `Approved by ${approved}`
    : blocked > 0
      ? `Changes requested by ${blocked}`
      : 'Awaiting review'
  const reviewDot = approved > 0 && blocked === 0 ? 'dot-ok' : blocked > 0 ? 'dot-bad' : 'dot-wait'

  const body = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      ${stateChip(pull.state)}
      <span class="who">${avatar(pull.author)}<b>${esc(pull.author.login)}</b></span>
      <span style="color:var(--faint);font-size:12.5px">
        wants to merge <code style="color:var(--text)">${esc(pull.branch.head)}</code> into
        <code style="color:var(--text)">${esc(pull.branch.base)}</code> · ${esc(ago(pull.createdAt))}
      </span>
    </div>
    ${labels ? `<div class="pills" style="margin-top:12px">${labels}</div>` : ''}
    ${
      pull.body
        ? `<div class="box">${bodyText(pull.body)}${pull.bodyTruncated ? '<div class="more">Body truncated — open the link for the rest.</div>' : ''}</div>`
        : '<div class="box" style="color:var(--faint)">No description.</div>'
    }
    <div class="kv" style="grid-template-columns:auto auto auto;margin-top:16px">
      <div><div class="l" style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em">Changed</div>
        <div style="font-size:18px;font-weight:650">${compact(pull.changedFiles)} <span style="font-size:12px;color:var(--faint);font-weight:400">files</span></div></div>
      <div><div class="l" style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em">Commits</div>
        <div style="font-size:18px;font-weight:650">${compact(pull.commits)}</div></div>
      <div><div class="l" style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em">Discussion</div>
        <div style="font-size:18px;font-weight:650">${compact(pull.comments)} <span style="font-size:12px;color:var(--faint);font-weight:400">comments</span></div></div>
    </div>
    <div class="scale" style="margin-top:14px">
      <span class="plus">+${esc(pull.additions)}</span>
      <span class="minus">−${esc(pull.deletions)}</span>
      <span class="bar"><i style="width:${plusPct}%;background:var(--green)"></i><i style="width:${100 - plusPct}%;background:var(--red)"></i></span>
    </div>
    <div class="checks">
      <span class="check"><span class="dot ${dot}"></span>${checkLabel}</span>
      <span class="check"><span class="dot ${reviewDot}"></span>${reviewLabel}</span>
      ${pull.isDraft ? '<span class="check"><span class="dot dot-wait"></span>Draft</span>' : ''}
      ${
        // Mergeability is only meaningful while the PR is open and unmerged.
        pull.state !== 'open'
          ? ''
          : pull.mergeableState === 'behind'
            ? '<span class="check"><span class="dot dot-wait"></span>Behind base</span>'
            : pull.mergeable === false
              ? '<span class="check"><span class="dot dot-bad"></span>Conflicts</span>'
              : ''
      }
    </div>
    ${
      checks.failing?.length
        ? `<div class="reply" style="border-color:var(--red);color:var(--red)">Failing: ${esc(checks.failing.join(', '))}</div>`
        : ''
    }
    ${
      (pull.replies ?? []).length
        ? pull.replies
            .map(
              (reply) => `<div class="reply"><div class="who">${avatar(reply.author)}<b>${esc(reply.author.login)}</b></div>${esc(replyText(reply.body))}</div>`,
            )
            .join('')
        : ''
    }
  `
  return shell({
    title: `<span style="color:var(--faint);font-weight:600">#${esc(pull.number)}</span> ${esc(pull.title)}`,
    subtitle: {
      left: `Pull request${pull.isDraft ? ' <span class="sep">·</span> draft' : ''}${
        pull.mergedAt ? ` <span class="sep">·</span> merged ${esc(ago(pull.mergedAt))}` : ''
      }`,
      right: esc(pull.repo),
      footLeft: `${pull.state === 'open' ? 'Open' : pull.state === 'merged' ? 'Merged' : 'Closed'} · updated ${esc(ago(pull.updatedAt))}`,
      footRight: pull.url,
    },
    body,
  })
}

/** The list card: several issues or PRs at a glance. */
export function listCard(list) {
  const rows = (list.items ?? [])
    .map((item) => {
      const kind = item.isPull ? 'PR' : 'Issue'
      const labels = (item.labels ?? []).slice(0, 3).map(labelPill).join(' ')
      return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="width:52px;flex:none;color:var(--faint);font-size:12.5px">#${esc(item.number)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;color:var(--text)">${esc(item.title)}</div>
          <div style="margin-top:3px;font-size:11.5px;color:var(--faint)">
            ${kind} · ${esc(item.state)} · ${esc(item.author)} · ${esc(ago(item.updatedAt))}
            ${labels ? ` ${labels}` : ''}
          </div>
        </div>
      </div>`
    })
    .join('')

  const prefix = list.state === 'closed' ? 'Closed' : list.state === 'all' ? '' : 'Open'
  const noun = list.kind === 'list-pr' ? 'pull requests' : list.kind === 'list-issue' ? 'issues' : ''
  const title = noun === ''
    ? 'Issues and pull requests'
    : prefix === ''
      ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`
      : `${prefix} ${noun}`
  return shell({
    title: esc(title),
    subtitle: {
      left: `${esc(list.repo)} <span class="sep">·</span> ${esc(list.state ?? 'open')}`,
      right: '',
      footLeft: `${list.items?.length ?? 0} shown`,
      footRight: `https://github.com/${list.repo}`,
    },
    body: rows || '<div class="box" style="color:var(--faint)">Nothing matched.</div>',
  })
}

/** The search card. */
export function searchCard(result) {
  const rows = (result.items ?? [])
    .map(
      (item) => `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="width:150px;flex:none;color:var(--faint);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.repository)}</div>
        <div style="width:52px;flex:none;color:var(--faint);font-size:12.5px">#${esc(item.number)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px">${esc(item.title)}</div>
          <div style="margin-top:2px;font-size:11.5px;color:var(--faint)">${item.isPull ? 'PR' : 'Issue'} · ${esc(item.state)} · ${esc(item.author)}</div>
        </div>
      </div>`,
    )
    .join('')
  return shell({
    title: esc(result.query),
    subtitle: {
      left: 'Search results',
      right: `${compact(result.total)} matches · ${result.items?.length ?? 0} shown`,
      footLeft: 'Searched GitHub issues and pull requests',
      footRight: 'https://github.com/search',
    },
    body: rows || '<div class="box" style="color:var(--faint)">Nothing matched.</div>',
  })
}

/** Pick the card builder for one normalized payload. */
export function cardFor(payload) {
  switch (payload?.kind) {
    case 'repo': return repoCard(payload)
    case 'issue': return issueCard(payload)
    case 'pr': return pullCard(payload)
    case 'list':
    case 'list-issue':
    case 'list-pr': return listCard(payload)
    case 'search': return searchCard(payload)
    default: throw new Error(`No card template for kind "${payload?.kind}".`)
  }
}

/**
 * Run the browser until it has written the screenshot, then stop it.
 *
 * A headless Chromium writes the `--screenshot` file and then keeps its
 * process resident (it does not necessarily exit), so waiting for the exit
 * event hangs forever. This waits for the output file to appear and settle
 * instead, which is the actual completion signal, and only then tears the
 * browser tree down.
 */
async function renderToFile(executable, args, outputPath, timeoutMs) {
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' })
  let spawnError
  child.on('error', (error) => { spawnError = error })

  /** Terminate this browser tree only — never anything else on the machine. */
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      // /T takes the renderer/GPU children with it; /F avoids a prompt.
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('exit', resolve)
        killer.on('error', resolve)
      })
      return
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + timeoutMs
  let lastSize = -1
  try {
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError
      await new Promise((resolve) => setTimeout(resolve, 120))
      let size = -1
      try {
        size = (await stat(outputPath)).size
      } catch {
        continue
      }
      // Two equal, non-empty sizes in a row mean the encoder has finished.
      if (size > 0 && size === lastSize) return
      lastSize = size
    }
    throw new Error(`The headless browser wrote no card within ${timeoutMs}ms.`)
  } finally {
    await stop()
  }
}

/** How many device pixels per CSS pixel the card is rendered at. */
const SCALE = 2

/**
 * Rasterize the card for one payload.
 * @param {object} payload normalized repo/issue/pr/list/search data
 * @returns {Promise<{png: Buffer, html: string, browser: string}>}
 */
const MAX_CONCURRENT_RENDERS = 2
const MAX_QUEUED_RENDERS = 16
let activeRenders = 0
const renderWaiters = []

/**
 * Cap how many headless browsers this module runs at once.
 *
 * Each card is a fresh browser process (1–2 s, tens of MB), and the routes that
 * trigger a render are reachable without authentication, so an unbounded
 * request rate would let one caller starve the machine. The panel renders one
 * view at a time anyway, and a tool call may overlap it once.
 */
async function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1
    return
  }
  if (renderWaiters.length >= MAX_QUEUED_RENDERS) {
    throw new Error('Too many card renders are queued; retry shortly.')
  }
  // The releaser transfers its slot to this waiter, so the wait itself must not
  // bump the count — otherwise an intervening acquire could raise it past the cap.
  await new Promise((resolve) => renderWaiters.push(resolve))
}

function releaseRenderSlot() {
  const next = renderWaiters.shift()
  if (next !== undefined) {
    // Hand the slot over: the count stays the same.
    next()
    return
  }
  activeRenders -= 1
}

export async function renderCard(payload, options = {}) {
  await acquireRenderSlot()
  try {
    return await renderCardWork(payload, options)
  } finally {
    releaseRenderSlot()
  }
}

async function renderCardWork(payload, { scale = SCALE, timeoutMs = 25_000 } = {}) {
  const browser = await findBrowser()
  if (browser === undefined) {
    throw new Error(
      'No headless browser was found for image rendering. Install Microsoft Edge or Google Chrome, or use the text output.',
    )
  }
  const html = cardFor(payload)
  const dir = await mkdtemp(join(tmpdir(), 'gh-view-'))
  const htmlPath = join(dir, 'card.html')
  const pngPath = join(dir, 'card.png')
  const profileDir = join(dir, 'profile')
  try {
    await writeFile(htmlPath, html, 'utf8')
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--force-device-scale-factor=${scale}`,
      `--user-data-dir=${profileDir}`,
      `--screenshot=${pngPath}`,
      '--window-size=760,1200',
      '--default-background-color=00000000',
      '--virtual-time-budget=4000',
      // pathToFileURL escapes `#` and `%`, which a raw file:/// string would
      // read as a fragment or an escape.
      pathToFileURL(htmlPath).href,
    ]
    await renderToFile(browser, args, pngPath, timeoutMs)
    const shot = await readFile(pngPath)
    const png = cropPng(shot)
    return { png, html, browser }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Crop the transparent tail a fixed window height leaves behind.
 *
 * The browser screenshots the whole window, so a short card sits above empty
 * rows. This trims them by scanning the alpha channel from the bottom, which
 * needs no image library: a PNG is decoded here only as far as the alpha test
 * requires.
 */
export function cropPng(png, { minHeight = 120, padding = 24 } = {}) {
  const info = readPngHeader(png)
  if (info === undefined) return png
  const { width, height, colorType, bitDepth } = info
  // Only the RGBA/RGB 8-bit forms browsers emit are handled; anything else is
  // returned untouched so a future browser change degrades to "no crop".
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return png
  const channels = colorType === 6 ? 4 : 3
  let idat = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  if (idat.length === 0) return png
  const raw = inflate(Buffer.concat(idat))
  const stride = width * channels
  const pixels = unfilter(raw, width, height, channels, stride)
  if (pixels === undefined) return png

  const isBlankRow = (y) => {
    for (let x = 0; x < width; x += 1) {
      const index = y * stride + x * channels
      const alpha = channels === 4 ? pixels[index + 3] : 255
      if (alpha > 8) return false
      if (channels === 3) {
        const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]]
        if (r > 8 || g > 8 || b > 8) return false
      }
    }
    return true
  }
  let bottom = height
  while (bottom > minHeight && isBlankRow(bottom - 1)) bottom -= 1
  if (bottom >= height) return png
  bottom = Math.min(height, bottom + padding)
  return encodePng(pixels, width, bottom, channels)
}

/** Read a PNG IHDR. Returns undefined when this is not a PNG. */
function readPngHeader(png) {
  if (png.length < 33) return undefined
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i += 1) if (png[i] !== signature[i]) return undefined
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  }
}

/** zlib inflate for the PNG decoder. */
function inflate(data) {
  return inflateSync(data)
}

/** Reverse PNG scanline filters into one flat pixel buffer. */
function unfilter(raw, width, height, channels, stride) {
  const pixels = Buffer.alloc(height * stride)
  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]
    position += 1
    const line = raw.subarray(position, position + stride)
    position += stride
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const previous = y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0
      const b = previous === undefined ? 0 : previous[x]
      const c = previous === undefined || x < channels ? 0 : previous[x - channels]
      const value = line[x]
      let out
      switch (filter) {
        case 0: out = value; break
        case 1: out = value + a; break
        case 2: out = value + b; break
        case 3: out = value + ((a + b) >> 1); break
        case 4: out = value + paeth(a, b, c); break
        default: return undefined
      }
      row[x] = out & 0xff
    }
  }
  return pixels
}

/** PNG Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC-32 as PNG chunks require. */
function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** Encode a cropped RGBA/RGB region back into a PNG. */
function encodePng(pixels, width, height, channels) {
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
