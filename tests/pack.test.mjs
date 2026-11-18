/**
 * Packed-artifact checks.
 *
 * A linked local install bypasses `files`, so the only honest check of what a
 * registry user receives is the pack list itself. This runs `npm pack
 * --dry-run --json` and inspects it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function packList() {
  const args = ['pack', '--dry-run', '--json']
  // A private cache directory keeps the check independent of the user's npm
  // cache permissions, and off the network.
  const env = { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), 'ghv-npm-cache-')) }
  // `npm` is a .cmd shim on Windows; run the shim through cmd.exe rather than
  // through a shell:true spawn (which is deprecated and needs escaping).
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    : spawnSync('npm', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
  assert.equal(result.status, 0, `npm pack --dry-run failed:\n${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  assert.ok(Array.isArray(parsed) && parsed.length === 1, 'expected one packed package')
  return parsed[0]
}

test('pack: the tarball carries every runtime file and the README image', () => {
  const packed = packList()
  const paths = new Set(packed.files.map((file) => file.path))
  for (const required of [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'lib/github.js',
    'lib/render.js',
    'lib/http-guard.js',
    'locale/en.json',
    'locale/zh.json',
    'icon.svg',
    'gh-view-overview.png',
    'README.md',
    'LICENSE',
    'package.json',
  ]) {
    assert.ok(paths.has(required), `tarball is missing ${required}`)
  }
})

test('pack: repository-only trees stay out of the tarball', () => {
  const packed = packList()
  const paths = packed.files.map((file) => file.path)
  for (const prefix of ['assets/', 'scripts/', 'tests/', '.github/']) {
    assert.ok(!paths.some((path) => path.startsWith(prefix)), `tarball must not contain ${prefix}`)
  }
  assert.ok(!paths.includes('.gitignore'))
  assert.ok(!paths.includes('CHANGELOG.md'))
})

test('pack: the installed package stays small and complete', () => {
  const packed = packList()
  assert.equal(packed.name, 'dsh-gh-view')
  assert.match(packed.version, /^\d+\.\d+\.\d+/)
  assert.ok(packed.entryCount >= 12, `expected at least 12 entries, got ${packed.entryCount}`)
  assert.ok(packed.size < 5 * 1024 * 1024, `tarball is ${packed.size} bytes, unexpectedly large`)
})
