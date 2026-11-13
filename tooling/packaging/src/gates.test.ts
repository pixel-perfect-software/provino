// The planted cases of the two gates that run real tools (T1.6): API Extractor refuses an export
// with no release tag, and publint and attw refuse a pack whose entry points don't resolve.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type ApiEntry, extract, publicApiChanged, reportBlocks } from './api-reports.ts'
import { attwTarball, lintPackAsync, publintTarball } from './lint-pack.ts'
import { packPackage, packPackageAsync } from './pack.ts'
import { readManifest } from './package-json.ts'
import { scratchDir } from './test-support.ts'
import type { WorkspacePackage } from './workspace.ts'

/** A package in a temp directory: its package.json, and `files` (relative path → text). */
function plantedPackage(
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): WorkspacePackage {
  const dir = scratchDir('planted', { 'package.json': JSON.stringify(manifest), ...files })
  return { dir, rel: 'planted', manifest: readManifest(dir) }
}

function entryOf(pkg: WorkspacePackage): ApiEntry {
  return {
    pkg,
    name: 'index',
    dts: join(pkg.dir, 'dist', 'index.d.ts'),
    report: 'etc/planted.api.md',
  }
}

const work = scratchDir('api-work')

describe('API Extractor gate (T1.6)', () => {
  test('an export with no release tag fails, naming it', () => {
    const pkg = plantedPackage(
      { name: '@provino/planted', version: '1.0.0', type: 'module' },
      {
        'dist/index.d.ts': [
          '/** Tagged. @public */',
          'export declare function tagged(): void;',
          '/** Forgot the tag. */',
          'export declare function untagged(): void;',
          '',
        ].join('\n'),
      },
    )
    const result = extract(entryOf(pkg), work)
    assert.equal(result.errors.length, 1, result.errors.join('\n'))
    assert.match(result.errors[0] ?? '', /ae-missing-release-tag: "untagged"/)
  })

  test('tagged exports pass and the report shows each declaration with its tier', () => {
    const pkg = plantedPackage(
      { name: '@provino/planted', version: '1.0.0', type: 'module' },
      {
        'dist/index.d.ts': [
          '/** @public */',
          'export declare function stable(a: number): string;',
          '/** @beta */',
          'export declare function evolving(): void;',
          '',
        ].join('\n'),
      },
    )
    const result = extract(entryOf(pkg), work)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(
      reportBlocks(result.report ?? '').flatMap((block) =>
        block.tag === 'none' ? [] : [block.tag],
      ),
      // API Extractor orders declarations by name: `evolving` before `stable`.
      ['beta', 'public'],
    )
    // LF, so a report written on one system is the report on every other.
    assert.ok(!(result.report ?? '').includes('\r'))
  })

  const report = (body: string): string => `## API Report File\n\n\`\`\`ts\n\n${body}\n\n\`\`\`\n`

  test('a changed @public signature counts as a public change; a @beta one does not', () => {
    const before = report(
      '// @public\nexport function a(x: number): void;\n\n// @beta\nexport function b(): void;',
    )
    const publicChanged = report(
      '// @public\nexport function a(x: string): void;\n\n// @beta\nexport function b(): void;',
    )
    const betaChanged = report(
      '// @public\nexport function a(x: number): void;\n\n// @beta\nexport function b(y: number): void;',
    )
    assert.equal(publicApiChanged(before, publicChanged), true)
    assert.equal(publicApiChanged(before, betaChanged), false)
    assert.equal(publicApiChanged(before, before), false)
  })

  test('adding, removing or demoting a @public declaration is a public change', () => {
    const one = report('// @public\nexport function a(): void;')
    const two = report(
      '// @public\nexport function a(): void;\n\n// @public\nexport function c(): void;',
    )
    const demoted = report('// @beta\nexport function a(): void;')
    assert.equal(publicApiChanged(one, two), true)
    assert.equal(publicApiChanged(two, one), true)
    assert.equal(publicApiChanged(one, demoted), true)
    // A package whose first report is committed has a new public API.
    assert.equal(publicApiChanged(undefined, one), true)
    assert.equal(publicApiChanged(undefined, report('// @beta\nexport function a(): void;')), false)
  })
})

describe('publint and attw gate (T1.6)', () => {
  const good = {
    name: '@provino/planted-good',
    version: '1.0.0',
    type: 'module',
    files: ['dist'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  }
  const out = scratchDir('packs')

  test('a package whose entry points resolve passes both', () => {
    const pkg = plantedPackage(good, {
      'dist/index.js': 'export const a = 1\n',
      'dist/index.d.ts': 'export declare const a: 1\n',
    })
    const packed = packPackage(pkg, out)
    assert.equal(publintTarball(packed, pkg.dir), undefined)
    assert.equal(attwTarball(packed, pkg.dir), undefined)
  })

  test('a types condition that names a file the pack lacks fails publint', () => {
    const pkg = plantedPackage(
      { ...good, name: '@provino/planted-no-types' },
      { 'dist/index.js': 'export const a = 1\n' },
    )
    assert.equal(publintTarball(packPackage(pkg, out), pkg.dir)?.tool, 'publint')
  })

  test('an entry point an ES module cannot import fails attw', () => {
    // Only `require` and `types`: no condition an `import` matches, so ESM resolution finds nothing.
    const pkg = plantedPackage(
      {
        ...good,
        name: '@provino/planted-require-only',
        exports: { '.': { types: './dist/index.d.ts', require: './dist/index.cjs' } },
      },
      { 'dist/index.cjs': 'exports.a = 1\n', 'dist/index.d.ts': 'export declare const a: 1\n' },
    )
    assert.equal(attwTarball(packPackage(pkg, out), pkg.dir)?.tool, 'attw')
  })

  test('an entry point written in CommonJS under "type": "module" fails publint', () => {
    const pkg = plantedPackage(
      { ...good, name: '@provino/planted-cjs' },
      {
        'dist/index.js': 'module.exports = { a: 1 }\n',
        'dist/index.d.ts': 'export declare const a: 1\n',
      },
    )
    const packed = packPackage(pkg, out)
    assert.equal(publintTarball(packed, pkg.dir)?.tool, 'publint')
  })

  test('the async path hygiene takes finds what the sync one does', async () => {
    const clean = plantedPackage(
      { ...good, name: '@provino/planted-async-good' },
      {
        'dist/index.js': 'export const a = 1\n',
        'dist/index.d.ts': 'export declare const a: 1\n',
      },
    )
    assert.deepEqual(await lintPackAsync(await packPackageAsync(clean, out), clean.dir), [])
    const broken = plantedPackage(
      {
        ...good,
        name: '@provino/planted-async-require-only',
        exports: { '.': { types: './dist/index.d.ts', require: './dist/index.cjs' } },
      },
      { 'dist/index.cjs': 'exports.a = 1\n', 'dist/index.d.ts': 'export declare const a: 1\n' },
    )
    const packed = packPackage(broken, out)
    const sync = [publintTarball(packed, broken.dir), attwTarball(packed, broken.dir)].filter(
      (problem) => problem !== undefined,
    )
    assert.ok(sync.length > 0)
    assert.deepEqual(await lintPackAsync(await packPackageAsync(broken, out), broken.dir), sync)
  })
})
