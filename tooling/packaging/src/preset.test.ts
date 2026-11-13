import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { NOTICES_FILE } from './pack-contents.ts'
import { type PackageManifest, readManifest } from './package-json.ts'
import { entriesOf, PRESET, packageConfig } from './preset.ts'
import { scratchDir } from './test-support.ts'
import { publicPackages, ROOT } from './workspace.ts'

function manifest(exports: PackageManifest['exports']): PackageManifest {
  return { ...readManifest(join(ROOT, 'packages/core')), name: 'planted', exports }
}

describe('the shared tsdown preset (T1.6)', () => {
  test('is ESM for Node 22.15 with Oxc declarations', () => {
    assert.equal(PRESET.format, 'esm')
    assert.equal(PRESET.platform, 'node')
    assert.equal(PRESET.target, 'node22.15')
    assert.deepEqual(PRESET.dts, { generator: 'oxc', sourcemap: false })
  })

  test('builds one entry per exports subpath that has a source file, named by its import target', () => {
    const entries = entriesOf(
      manifest({
        '.': {
          'provino-source': './src/index.ts',
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './node': {
          'provino-source': './src/node/index.ts',
          types: './dist/node/index.d.ts',
          import: './dist/node/index.js',
        },
        './package.json': { 'provino-source': './package.json', default: './package.json' },
      }),
    )
    assert.deepEqual(
      entries.map(({ subpath, name, source }) => [subpath, name, source]),
      [
        ['.', 'index', 'src/index.ts'],
        ['./node', 'node/index', 'src/node/index.ts'],
      ],
    )
  })

  test('a subpath with no import condition is declarations only, and a package is one or the other', () => {
    const typesOnly = entriesOf(
      manifest({ '.': { 'provino-source': './src/index.ts', types: './dist/index.d.ts' } }),
    )
    assert.deepEqual(
      typesOnly.map(({ name, typesOnly }) => [name, typesOnly]),
      [['index', true]],
    )
    assert.throws(
      () =>
        entriesOf(
          manifest({
            '.': { 'provino-source': './src/index.ts', types: './dist/index.d.ts' },
            './x': {
              'provino-source': './src/x.ts',
              types: './dist/x.d.ts',
              import: './dist/x.js',
            },
          }),
        ),
      /some exports have an "import" condition and some have none/,
    )
  })

  test("a subpath whose types name a file that isn't its entry, or whose import is not a dist file, fails the build", () => {
    assert.throws(
      () =>
        entriesOf(
          manifest({
            '.': {
              'provino-source': './src/index.ts',
              types: './dist/index.d.ts',
              import: './index.js',
            },
          }),
        ),
      /needs an "import" condition/,
    )
    assert.throws(
      () =>
        entriesOf(
          manifest({
            '.': {
              'provino-source': './src/index.ts',
              types: './dist/other.d.ts',
              import: './dist/index.js',
            },
          }),
        ),
      /types must be \.\/dist\/index\.d\.ts/,
    )
  })

  test("a package's config keeps its declared dependencies external and allows no other import", () => {
    const dir = scratchDir('preset', {
      'package.json': JSON.stringify({
        name: '@provino/planted',
        type: 'module',
        exports: {
          '.': {
            'provino-source': './src/index.ts',
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
        dependencies: { zod: '1.0.0' },
        peerDependencies: { jsdom: '*' },
        devDependencies: { 'only-dev': '1.0.0' },
      }),
    })
    const config = packageConfig(dir)
    assert.equal(config.cwd, dir)
    assert.deepEqual(config.entry, { index: 'src/index.ts' })
    assert.deepEqual(config.deps, {
      onlyBundle: [],
      onlyImport: ['@provino/planted', 'jsdom', 'zod'],
    })
  })
})

describe('every published package is built by the preset', () => {
  const packages = publicPackages().filter((pkg) => pkg.manifest.name !== 'provino')

  test('has a build script that points at the shared config', () => {
    assert.ok(packages.length >= 19, `${packages.length} packages`)
    for (const pkg of packages) {
      assert.equal(
        pkg.manifest.scripts.build,
        'tsdown --config ../../tooling/packaging/tsdown.config.ts',
        pkg.manifest.name,
      )
    }
  })

  test('lists provino-source, then types, then import for every subpath, and ships only dist', () => {
    for (const pkg of packages) {
      // `dist`, and the notices file where the build holds copied code (`pnpm hygiene` `packs`
      // fails a package that needs it and doesn't list it).
      const files = JSON.stringify(pkg.manifest.files)
      assert.ok(
        [['dist'], ['dist', NOTICES_FILE]].some((allowed) => JSON.stringify(allowed) === files),
        `${pkg.manifest.name}: files is ${files}`,
      )
      for (const [subpath, conditions] of Object.entries(pkg.manifest.exports)) {
        assert.deepEqual(
          Object.keys(conditions),
          // `@provino/types` is types only (T1.2): no `import`, and no JavaScript in the pack.
          pkg.manifest.name === '@provino/types'
            ? ['provino-source', 'types']
            : ['provino-source', 'types', 'import'],
          `${pkg.manifest.name} ${subpath}`,
        )
      }
      assert.ok(entriesOf(pkg.manifest).length > 0, pkg.manifest.name)
    }
  })
})

describe('the umbrella build script', () => {
  test('points at the umbrella config', () => {
    const umbrella = publicPackages().find((pkg) => pkg.manifest.name === 'provino')
    assert.equal(
      umbrella?.manifest.scripts.build,
      'tsdown --config ../../tooling/packaging/tsdown.umbrella.config.ts',
    )
  })
})
