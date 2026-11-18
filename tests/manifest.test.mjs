/**
 * Release-manifest checks.
 *
 * These are the gates that make a packed install work: a bundle must declare
 * its patch, its exports must resolve, the locale/icon metadata must be
 * complete, and the package must be publishable. `npm test` runs them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('manifest: identity, licence and repository', () => {
  assert.equal(pkg.name, 'dsh-gh-view')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.ok(read('LICENSE').includes('MIT License'))
  assert.match(pkg.repository?.url ?? '', /github\.com\/ModiAWA\/dsh-gh-view\.git$/)
  assert.equal(pkg.bugs?.url, 'https://github.com/ModiAWA/dsh-gh-view/issues')
  assert.equal(pkg.homepage, 'https://github.com/ModiAWA/dsh-gh-view#readme')
})

test('manifest: publishable, not private', () => {
  // `npm publish` throws EPRIVATE for a private package (libnpmpublish), and
  // `npm publish --dry-run` does not catch it — so this gate is explicit.
  assert.notEqual(pkg.private, true)
})

test('manifest: DSH and Node requirements are declared', () => {
  assert.equal(typeof pkg.engines?.node, 'string')
  assert.equal(typeof pkg.engines?.dsh, 'string')
  // The range must admit the release it was written against; `^0.2.2` would
  // reject 0.2.2-rc.3, so the prerelease lower bound is load-bearing.
  assert.ok(pkg.engines.dsh.includes('0.2.2-rc.3'), `engines.dsh must admit 0.2.2-rc.3, got ${pkg.engines.dsh}`)
})

test('manifest: bundle declaration and patch row agree', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id:\s*gh-view/)
  assert.match(patch, /name:\s*dsh-gh-view/)
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(typeof pkg.dsh?.client?.immediately, 'boolean')
  // The row and the Host half must agree on the module name.
  assert.match(read('index.js'), /export const name = 'gh-view'/)
})

test('manifest: every export target exists', () => {
  const exports = pkg.exports ?? {}
  for (const [key, target] of Object.entries(exports)) {
    if (key.includes('*')) continue
    const path = typeof target === 'string' ? target : target.default
    assert.ok(path, `export ${key} has no target`)
    assert.ok(existsSync(join(root, path)), `export ${key} -> ${path} is missing`)
  }
  assert.equal(exports['.'], './index.js')
  assert.equal(exports['./client'], './client.js')
  assert.equal(exports['./icon'], './icon.svg')
  assert.equal(exports['./lib/*'], './lib/*')
  assert.equal(exports['./locale/*.json'], './locale/*.json')
})

test('manifest: files ships the runtime and the README image, not repo-only trees', () => {
  const files = pkg.files ?? []
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'lib', 'icon.svg', 'gh-view-overview.png']) {
    assert.ok(files.includes(required), `files must include ${required}`)
  }
  for (const excluded of ['assets', 'scripts', 'tests', '.github']) {
    assert.ok(!files.includes(excluded), `files must not include the repo-only path ${excluded}`)
  }
})

test('manifest: display metadata is complete in every locale', () => {
  const locales = { en: JSON.parse(read('locale/en.json')), zh: JSON.parse(read('locale/zh.json')) }
  for (const [language, locale] of Object.entries(locales)) {
    assert.equal(typeof locale.meta?.title, 'string', `${language} meta.title`)
    assert.equal(typeof locale.meta?.description, 'string', `${language} meta.description`)
    assert.ok(locale.meta.title.trim().length > 0, `${language} meta.title is empty`)
    assert.ok(locale.meta.description.trim().length > 0, `${language} meta.description is empty`)
    // A declared detail document must exist, or the detail page shows an error
    // instead of falling back to the README.
    if (locale.meta?.detail !== undefined) {
      assert.ok(existsSync(join(root, locale.meta.detail)), `${language} meta.detail -> ${locale.meta.detail} is missing`)
    }
  }
})

test('manifest: icon is a real SVG within the plugin-manager limit', () => {
  const bytes = readFileSync(join(root, 'icon.svg'))
  assert.ok(bytes.length <= 256 * 1024, `icon is ${bytes.length} bytes, over the 256 KiB limit`)
  assert.ok(bytes.toString('utf8').trim().startsWith('<svg'), 'icon.svg must be an SVG document')
})

test('manifest: health reports the version from package.json, not a literal', () => {
  const host = read('index.js')
  assert.match(host, /readFileSync\(new URL\('\.\/package\.json', import\.meta\.url\)/, 'index.js should derive the version from package.json')
  assert.match(host, /version: VERSION/)
})
