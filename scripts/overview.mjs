/**
 * Build the delivery overview image for gh-view.
 *
 * One wide card: what the plugin is, the two surfaces, the four agent tools,
 * the data path, and the verified state. Rendered with the same headless
 * browser path the plugin itself uses.
 *
 * Usage: `node scripts/overview.mjs [output.png]`
 *
 * The browser is discovered the same way the plugin discovers it (Edge or
 * Chrome, per platform), so this runs wherever the plugin can render cards.
 * The written PNG is self-contained: screenshots are embedded as data URLs.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

import { findBrowser } from '../lib/render.js'

/** Repository root, resolved from this script rather than the caller's cwd. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const OUT = process.argv[2] === undefined
  ? join(ROOT, 'gh-view-overview.png')
  : resolve(process.argv[2])
const BROWSER = await findBrowser()
if (BROWSER === undefined) {
  console.error('No Microsoft Edge or Google Chrome found; install one and retry.')
  process.exit(1)
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Embed a PNG as a data URL so the overview is a single self-contained file. */
async function dataUrl(relPath) {
  try {
    const bytes = await readFile(join(ROOT, relPath))
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

const prShot = await dataUrl('assets/shot-pr.png')
const issueShot = await dataUrl('assets/shot-issue.png')

const TOOLS = [
  { name: 'gh_view', sig: 'ref: "#123"  ·  repo?', what: 'One issue or PR. Works out which one.' },
  { name: 'gh_repo', sig: 'repo?  → workspace remotes', what: 'Stars, forks, watchers, open counts, topics.' },
  { name: 'gh_list', sig: 'kind, state, sort?, labels?', what: 'Issues or PRs, newest first.' },
  { name: 'gh_search', sig: 'query, limit?', what: 'GitHub search syntax across repos.' },
]

const ROUTES = [
  '/gh-view/repo', '/gh-view/view', '/gh-view/list', '/gh-view/search',
  '/gh-view/repo-card', '/gh-view/view-card', '/gh-view/health',
]

const CHECKS = [
  'All 4 tools return text + image blocks',
  'Real PNG card verified in agent context (sha256 match)',
  'Whole sidebar row opens the panel (full screen)',
  'Rows: draft · checks · review verdict · assignees',
  'PR list in one GraphQL round trip (no per-row REST)',
  'Bodies and comments render markdown, collapse',
  'Sort by created or updated, always newest first',
  'Filters: state / labels / in:title, server-side',
  'Query block collapses once a repo is open',
  'Workspace remotes: upstream preferred over origin',
  'CJK body, colored labels, replies render correctly',
  'Error path fails cleanly, no crash',
]

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body {
  width: 1180px; padding: 34px 38px 30px;
  background: #0b0f14; color: #e6edf3;
  font: 13.5px/1.6 "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.eyebrow { font-size: 11.5px; letter-spacing: .18em; text-transform: uppercase; color: #7d8590; }
h1 { font-size: 30px; letter-spacing: -.02em; margin: 6px 0 8px; font-weight: 680; }
h1 code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 27px; color: #58a6ff; }
.deck { color: #9aa4b2; font-size: 14px; max-width: 940px; }
.rule { height: 1px; background: #21262d; margin: 22px 0 20px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.panel { background: #11161d; border: 1px solid #262d36; border-radius: 12px; padding: 15px 17px; }
.panel h2 {
  font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
  color: #7d8590; font-weight: 700; margin-bottom: 11px;
}
.surface { display: flex; gap: 9px; align-items: flex-start; padding: 7px 0; }
.surface + .surface { border-top: 1px solid #1c222a; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; margin-top: 7px; }
.dot-ui { background: #3fb950; } .dot-cli { background: #a371f7; } .dot-auto { background: #58a6ff; }
.surface b { display: block; font-size: 13px; font-weight: 620; }
.surface span { color: #8b949e; font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 7px 0; vertical-align: top; border-top: 1px solid #1c222a; }
tr:first-child td { border-top: 0; }
td.t { width: 92px; }
td.t code {
  font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px;
  color: #79c0ff; font-weight: 600;
}
td.s code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 11px; color: #8b949e; }
td.w { color: #c9d1d9; font-size: 12.5px; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 4px; }
.shot { border: 1px solid #262d36; border-radius: 10px; overflow: hidden; background: #0d1117; }
.shot img { display: block; width: 100%; height: auto; }
.shot .cap {
  padding: 6px 10px; font-size: 11px; color: #7d8590; border-top: 1px solid #262d36;
  display: flex; justify-content: space-between; gap: 8px;
}
.shot .cap b { color: #c9d1d9; font-weight: 600; }
.flow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; margin-top: 3px; }
.node {
  background: #161b22; border: 1px solid #30363d; border-radius: 7px; padding: 5px 10px;
  font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.5px; color: #c9d1d9;
}
.node.hot { border-color: #1f6feb; color: #79c0ff; }
.arrow { color: #484f58; }
.checks { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 16px; }
.check { display: flex; gap: 7px; font-size: 12px; color: #c9d1d9; align-items: flex-start; }
.check i { color: #3fb950; font-style: normal; font-weight: 700; flex: none; }
.routes { display: flex; flex-wrap: wrap; gap: 5px; }
.route {
  font-family: "Cascadia Mono", Consolas, monospace; font-size: 10.5px;
  background: #161b22; border: 1px solid #262d36; border-radius: 5px;
  padding: 2px 7px; color: #8b949e;
}
.foot {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  margin-top: 20px; padding-top: 13px; border-top: 1px solid #21262d;
  font-size: 11px; color: #6e7681;
}
.foot code { font-family: "Cascadia Mono", Consolas, monospace; color: #8b949e; }
.badge {
  display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .06em;
  padding: 2px 8px; border-radius: 999px; vertical-align: 3px; margin-left: 8px;
}
.badge-ok { background: rgba(63,185,80,.16); color: #3fb950; border: 1px solid rgba(63,185,80,.42); }
</style></head>
<body>
  <div class="eyebrow">DeepSeek Harness plugin · bundle + agent tools</div>
  <h1><code>gh-view</code><span class="badge badge-ok">v${esc(pkg.version)}</span></h1>
  <p class="deck">
    Browse GitHub repos, issues and pull requests by <b>#number</b>. A rich side panel for
    the visible GUI, and a rendered <b>PNG card</b> for agent terminals that have no GUI —
    one data layer, both surfaces agree.
  </p>

  <div class="rule"></div>

  <div class="grid">
    <div class="panel">
      <h2>Two surfaces, one core</h2>
      <div class="surface">
        <span class="dot dot-ui"></span>
        <div><b>Full-screen panel — visible GUI</b>
          <span>Click the whole GitHub row in the left sidebar; it opens the panel in the main column.
          Also available as a right-column tab.</span></div>
      </div>
      <div class="surface">
        <span class="dot dot-auto"></span>
        <div><b>Reads like the GitHub web UI</b>
          <span>Rows carry draft · checks · review verdict · assignees · linked PRs. Bodies and comments
          render markdown and collapse when long.</span></div>
      </div>
      <div class="surface">
        <span class="dot dot-cli"></span>
        <div><b>PNG card — headless agents</b>
          <span>Same lookup returns a self-contained image card: repo stats, issue body, PR diff size and checks.</span></div>
      </div>
      <div class="surface">
        <span class="dot dot-auto"></span>
        <div><b>Follows the workspace</b>
          <span>Scoped per workspace, not global: reads that directory's git remotes and defaults to
          <code style="color:#79c0ff">upstream</code> over <code style="color:#79c0ff">origin</code>. Both present → a remote selector.</span></div>
      </div>
      <div class="flow" style="margin-top:12px">
        <span class="node">agent tool</span><span class="arrow">/</span>
        <span class="node">panel fetch</span><span class="arrow">→</span>
        <span class="node hot">lib/github.js</span><span class="arrow">→</span>
        <span class="node hot">lib/render.js</span>
      </div>
    </div>

    <div class="panel">
      <h2>Agent tools</h2>
      <table>
        ${TOOLS.map((t) => `<tr><td class="t"><code>${esc(t.name)}</code></td>
          <td><div class="w">${esc(t.what)}</div><div class="s"><code>${esc(t.sig)}</code></div></td></tr>`).join('')}
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top:16px">
    <h2>What the cards look like</h2>
    <div class="shots">
      <div class="shot">
        ${prShot ? `<img src="${prShot}" alt="pull request card">` : '<div style="padding:30px;color:#6e7681">screenshot missing</div>'}
        <div class="cap"><span><b>Pull request</b> — Title, author, body, +/− size, checks, review state</span><span>1520×1815</span></div>
      </div>
      <div class="shot">
        ${issueShot ? `<img src="${issueShot}" alt="issue card">` : '<div style="padding:30px;color:#6e7681">screenshot missing</div>'}
        <div class="cap"><span><b>Issue</b> — CJK body, colored labels, replies, comment count</span><span>1520×1604</span></div>
      </div>
    </div>
  </div>

  <div class="grid" style="margin-top:16px">
    <div class="panel">
      <h2>Verified in the running app</h2>
      <div class="checks">
        ${CHECKS.map((c) => `<div class="check"><i>✓</i><span>${esc(c)}</span></div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h2>How it renders &amp; where data comes from</h2>
      <div class="flow">
        <span class="node">card HTML</span><span class="arrow">→</span>
        <span class="node hot">headless Edge</span><span class="arrow">→</span>
        <span class="node">PNG</span><span class="arrow">→</span>
        <span class="node">auto-crop</span>
      </div>
      <p style="color:#8b949e;font-size:12px;margin-top:9px">
        Chromium already on the machine rasterizes the card, so CJK wrapping and font
        fallback match a browser. Data comes from the <code style="color:#79c0ff">gh</code>
        CLI when present (private repos, no token handled here), else the public REST API.
      </p>
      <div class="routes" style="margin-top:10px">
        ${ROUTES.map((r) => `<span class="route">${esc(r)}</span>`).join('')}
      </div>
    </div>
  </div>

  <div class="foot">
    <span><code>${esc(pkg.name)}@${esc(pkg.version)}</code> · patch <code>cordis.patch.yml</code> · row <code>include:gh-view</code></span>
    <code>gh_repo · gh_list · gh_view · gh_search</code>
  </div>
</body></html>`

const dir = await mkdtemp(join(tmpdir(), 'ghv-overview-'))
const htmlPath = join(dir, 'overview.html')
const pngPath = OUT
await writeFile(htmlPath, html, 'utf8')

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  '--force-device-scale-factor=2', `--user-data-dir=${join(dir, 'profile')}`,
  `--screenshot=${pngPath}`, '--window-size=1180,2400',
  '--virtual-time-budget=6000', pathToFileURL(htmlPath).href,
], { windowsHide: true, stdio: 'ignore' })

// The output file outlives this run, so "the size stopped changing" matches the
// PREVIOUS image immediately. Delete it first and track a size seen at least
// once after the browser started, which is what makes the wait meaningful.
await rm(pngPath, { force: true }).catch(() => {})

let lastSize = -1
let settled = 0
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 150))
  let size = -1
  try {
    size = (await stat(pngPath)).size
  } catch {
    continue // not written yet
  }
  if (size > 0 && size === lastSize) {
    settled += 1
    // Two consecutive equal readings mean the encoder has finished flushing.
    if (settled >= 2) break
  } else {
    settled = 0
  }
  lastSize = size
}
// Stop only the browser this script started. Windows needs the process-tree
// kill; elsewhere the headless process is signalled if it is still running.
if (process.platform === 'win32') {
  await new Promise((done) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    k.on('exit', done); k.on('error', done)
  })
} else if (child.exitCode === null) {
  child.kill('SIGKILL')
}

// A fixed window height always leaves dead space under the content, so trim the
// trailing rows that match the page background before shipping the image.
const raw = await readFile(pngPath)
await writeFile(pngPath, cropToBackground(raw, [0x0b, 0x0f, 0x14]))
await rm(dir, { recursive: true, force: true }).catch(() => {})
console.log('overview written:', pngPath, (await stat(pngPath)).size, 'bytes')

/** Decode a PNG just far enough to drop trailing background rows. */
function cropToBackground(png, bg, pad = 20) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i += 1) if (png[i] !== sig[i]) return png
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const bitDepth = png[24]
  const colorType = png[25]
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return png
  const channels = colorType === 6 ? 4 : 3

  const idat = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0
      const b = prev === undefined ? 0 : prev[x]
      const c = prev === undefined || x < channels ? 0 : prev[x - channels]
      const v = line[x]
      let out
      if (filter === 0) out = v
      else if (filter === 1) out = v + a
      else if (filter === 2) out = v + b
      else if (filter === 3) out = v + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else return png
      row[x] = out & 0xff
    }
  }

  const isBackground = (y) => {
    for (let x = 0; x < width; x += 1) {
      const i = y * stride + x * channels
      if (channels === 4 && pixels[i + 3] < 8) continue
      if (Math.abs(pixels[i] - bg[0]) > 6 || Math.abs(pixels[i + 1] - bg[1]) > 6 || Math.abs(pixels[i + 2] - bg[2]) > 6) return false
    }
    return true
  }

  let bottom = height
  while (bottom > 100 && isBackground(bottom - 1)) bottom -= 1
  bottom = Math.min(height, bottom + pad)
  if (bottom >= height) return png

  const outStride = width * channels
  const outRaw = Buffer.alloc(bottom * (outStride + 1))
  for (let y = 0; y < bottom; y += 1) {
    outRaw[y * (outStride + 1)] = 0
    pixels.copy(outRaw, y * (outStride + 1) + 1, y * outStride, (y + 1) * outStride)
  }
  const table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = -1
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(bottom, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from(sig),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(outRaw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
