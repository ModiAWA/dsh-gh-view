/**
 * Release-doc checks.
 *
 * The README is also the Plugin Manager detail page fallback, and it is what
 * an npm visitor sees first, so a broken fence or a machine-local path is a
 * release defect rather than a typo. These checks keep it honest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const README = read('README.md')

/** Case-insensitive scan for paths that only exist on the author's machine. */
const MACHINE_PATHS = [/D:\\code\\gh-view/i, /C:\\Users\\Modi/i, /C:\\Program Files \(x86\)\\Microsoft\\Edge/i]

test('docs: README fences are balanced and no heading is swallowed', () => {
  const lines = README.split(/\r?\n/)
  let fenced = false
  for (const [index, line] of lines.entries()) {
    if (/^ {0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      assert.doesNotMatch(
        line,
        /^#{1,6}\s/,
        `README line ${index + 1} is a heading inside a code fence — a stray fence near it breaks the rendered page`,
      )
    }
  }
  assert.equal(fenced, false, 'README has an unclosed code fence')
})

test('docs: README points at a shipped image', () => {
  assert.match(README, /!\[[^\]]*\]\(\.\/gh-view-overview\.png\)/)
  assert.ok(existsSync(join(root, 'gh-view-overview.png')), 'README overview image is missing')
})

test('docs: install section uses the real DSH CLI grammar', () => {
  assert.doesNotMatch(README, /dsh plugin install/, '`dsh plugin install` is not a CLI command')
  assert.match(README, /dsh plugin --profile <profile> add dsh-gh-view/)
})

test('docs: tool and metadata claims match the shipped bundle', () => {
  for (const tool of ['gh_repo', 'gh_list', 'gh_view', 'gh_search']) {
    assert.ok(README.includes(tool), `README does not mention ${tool}`)
  }
  assert.ok(README.includes('workspaceRegistry'), 'README must name the required workspaceRegistry service')
  assert.ok(README.includes('engines.dsh'), 'README must mention the DSH version requirement')
  assert.ok(README.includes('image: false'), 'README must document the text-only switch')
})

test('docs: no contributor-machine paths leak into shipped files', () => {
  const shipped = ['index.js', 'client.js', 'lib/github.js', 'lib/render.js', 'package.json', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'scripts/overview.mjs']
  for (const file of shipped) {
    const text = read(file)
    for (const pattern of MACHINE_PATHS) {
      assert.doesNotMatch(text, pattern, `${file} contains a machine-local path (${pattern})`)
    }
  }
})

test('docs: the overview generator is portable', () => {
  const script = read('scripts/overview.mjs')
  assert.match(script, /findBrowser/, 'overview script should reuse the plugin browser discovery')
  assert.match(script, /process\.platform === 'win32'/, 'the process-tree kill must be platform-gated')
  assert.doesNotMatch(script, /Program Files \(x86\)/, 'no hardcoded browser path')
})
