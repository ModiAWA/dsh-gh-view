/**
 * Data-layer and card-template checks.
 *
 * Everything here is offline: pure normalization, escaping and git-remote
 * parsing. Network lookups and rasterization are exercised by hand instead —
 * the CI runner has no GitHub token and no Chromium.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { GhViewError, clipBody, detectRemotes, normalizeRepo, parseRef, plainExcerpt } from '../lib/github.js'
import { cardFor, findBrowser } from '../lib/render.js'

const execFileAsync = promisify(execFile)

test('normalizeRepo: accepts canonical names and GitHub URLs', () => {
  assert.equal(normalizeRepo('AstrBotDevs/AstrBot'), 'AstrBotDevs/AstrBot')
  assert.equal(normalizeRepo('  owner/repo  '), 'owner/repo')
  assert.equal(normalizeRepo('owner/repo.git'), 'owner/repo')
  assert.equal(normalizeRepo('https://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(normalizeRepo('https://github.com/owner/repo/issues/1'), 'owner/repo')
  assert.equal(normalizeRepo('github.com/owner/repo'), 'owner/repo')
  assert.equal(normalizeRepo('owner/.github'), 'owner/.github', '.github is a real repository name')
  // SSH clones are the common developer setup; the default-repository detection
  // must not silently lose them.
  assert.equal(normalizeRepo('git@github.com:owner/repo.git'), 'owner/repo')
  assert.equal(normalizeRepo('ssh://git@github.com/owner/repo.git'), 'owner/repo')
  assert.equal(normalizeRepo('git://github.com/owner/repo.git'), 'owner/repo')
  assert.equal(normalizeRepo(undefined), undefined)
  assert.equal(normalizeRepo(''), undefined)
})

test('normalizeRepo: rejects flag and file-reference shapes', () => {
  for (const bad of [
    '../etc',
    'owner/..',
    '-flag/repo',
    '@secret/repo',
    'not a repo',
    'https://github.com/@C:\\x/y',
    'git@github.com:@secret/repo.git',
    'ssh://git@github.com/-flag/repo.git',
    'git@github.com:owner/..',
  ]) {
    assert.throws(() => normalizeRepo(bad), GhViewError, `should reject ${JSON.stringify(bad)}`)
  }
})

test('parseRef: accepts #123, 123 and owner/repo#123', () => {
  assert.deepEqual(parseRef('#123'), { repo: undefined, number: 123 })
  assert.deepEqual(parseRef('123'), { repo: undefined, number: 123 })
  assert.deepEqual(parseRef('  #7  '), { repo: undefined, number: 7 })
  assert.deepEqual(parseRef('AstrBotDevs/AstrBot#11099'), { repo: 'AstrBotDevs/AstrBot', number: 11099 })
})

test('parseRef: rejects non-references with the error code', () => {
  for (const bad of ['abc', '#x12', 'owner/repo', '12 13']) {
    assert.throws(
      () => parseRef(bad),
      (error) => error instanceof GhViewError && error.code === 'GH_VIEW_BAD_REF',
      `should reject ${JSON.stringify(bad)}`,
    )
  }
})

test('clipBody: strips HTML comments and truncates with an ellipsis', () => {
  assert.deepEqual(clipBody('hello'), { text: 'hello', truncated: false })
  assert.deepEqual(clipBody('a<!-- machine marker -->b'), { text: 'ab', truncated: false })
  const long = 'x'.repeat(500)
  const clipped = clipBody(long, 100)
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.text.length, 101)
  assert.ok(clipped.text.endsWith('…'))
})

test('plainExcerpt: removes markdown syntax before clipping', () => {
  assert.equal(plainExcerpt('[label](https://example.com)', 160), 'label')
  assert.equal(plainExcerpt('**bold** and `code`', 160), 'bold and code')
  assert.equal(plainExcerpt('# heading', 160), 'heading')
  assert.equal(plainExcerpt('- first\n- second', 160), '• first • second')
  assert.ok(plainExcerpt('y'.repeat(200), 50).endsWith('…'))
})

test('detectRemotes: prefers nothing implicitly, reports origin and upstream', async (t) => {
  try {
    await execFileAsync('git', ['--version'])
  } catch {
    t.skip('git is not installed')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'ghv-remotes-'))
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/owner/widgets.git'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'upstream', 'git@github.com:project/upstream.git'], { cwd: dir })
    await execFileAsync('git', ['remote', 'add', 'mirror', 'https://gitlab.com/other/thing.git'], { cwd: dir })

    const remotes = await detectRemotes(dir)
    assert.equal(remotes.origin, 'owner/widgets')
    assert.equal(remotes.upstream, 'project/upstream')
    assert.deepEqual(remotes.remotes.map((remote) => remote.name).sort(), ['origin', 'upstream'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('detectRemotes: no directory means no remotes', async () => {
  assert.deepEqual(await detectRemotes(undefined), { origin: null, upstream: null, remotes: [] })
})

test('cardFor: escapes untrusted text instead of injecting markup', () => {
  const html = cardFor({
    kind: 'repo',
    fullName: 'owner/repo',
    description: '<script>alert(1)</script>',
    stars: 1,
    forks: 2,
    watchers: 3,
    openIssues: 4,
    openPulls: 5,
    topics: ['<b>topic</b>'],
    owner: 'owner',
    url: 'https://github.com/owner/repo',
  })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;b&gt;topic&lt;/b&gt;'))
})

test('cardFor: rejects an unknown payload kind', () => {
  assert.throws(() => cardFor({ kind: 'nonsense' }), /No card template/)
})

test('findBrowser: returns an absolute executable path or nothing', async () => {
  const browser = await findBrowser()
  if (browser !== undefined) assert.ok(isAbsolute(browser), `browser path should be absolute, got ${browser}`)
})
