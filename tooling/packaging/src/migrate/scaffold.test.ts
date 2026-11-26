import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { TEST_DEPENDS_ON, TEST_RUNNER } from '../dogfood.ts'
import { scratchDir } from '../test-support.ts'
import { scaffoldPackage } from './scaffold.ts'

function workspace() {
  return scratchDir('scaffold', {
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: 'packages/a' }, { path: 'packages/b' }],
    }),
    'tooling/provino/bootstrap.json': JSON.stringify({
      files: { 'packages/a/src/x.test.ts': 'why' },
    }),
    'packages/a/package.json': JSON.stringify({
      name: 'a',
      scripts: { test: 'node --test "src/**/*.test.ts"' },
    }),
    'packages/a/tsconfig.json': JSON.stringify({ include: ['src'] }),
  })
}

describe('scaffoldPackage', () => {
  it('writes the config, tests project, turbo.json, exclude, root reference and script', async () => {
    const root = workspace()
    const written = await scaffoldPackage(root, join(root, 'packages/a'))
    // config, tests project (seeded, then merged), turbo.json, exclude, root reference, script
    assert.equal(written.length, 7)
    assert.match(
      await readFile(join(root, 'packages/a/provino.config.ts'), 'utf8'),
      /packageConfig\(import\.meta\.dirname\)/,
    )
    const tsconfig = JSON.parse(await readFile(join(root, 'packages/a/tsconfig.json'), 'utf8'))
    assert.deepEqual(tsconfig.exclude, ['src/**/*.test.ts'])
    const rootConfig = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))
    assert.deepEqual(
      rootConfig.references.map((reference: { path: string }) => reference.path),
      ['packages/a', 'packages/a/tsconfig.tests.json', 'packages/b'],
    )
    const manifest = JSON.parse(await readFile(join(root, 'packages/a/package.json'), 'utf8'))
    assert.equal(
      manifest.scripts.test,
      `${TEST_RUNNER} && node --test --conditions=provino-source src/x.test.ts`,
    )
  })

  it("writes the turbo test task's dependsOn from testDependsOn", async () => {
    const root = workspace()
    await scaffoldPackage(root, join(root, 'packages/a'))
    const turbo = JSON.parse(await readFile(join(root, 'packages/a/turbo.json'), 'utf8'))
    assert.deepEqual(turbo.tasks.test.dependsOn, [...TEST_DEPENDS_ON])
  })

  it("merges into an existing exclude and derives the tests project's references from the dependencies", async () => {
    const root = scratchDir('scaffold-merge', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [{ path: 'packages/a' }] }),
      'packages/types/package.json': '{}',
      'packages/core/package.json': '{}',
      'packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: { '@provino/core': 'workspace:*', '@provino/missing': 'workspace:*' },
      }),
      'packages/a/tsconfig.json': JSON.stringify({ include: ['src'], exclude: ['src/gen'] }),
    })
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.ok(
      lines.some((line) => line.startsWith('packages/a/tsconfig.json: exclude gained')),
      lines.join('\n'),
    )
    const tsconfig = JSON.parse(await readFile(join(root, 'packages/a/tsconfig.json'), 'utf8'))
    assert.deepEqual(tsconfig.exclude, ['src/gen', 'src/**/*.test.ts'])
    const tests = JSON.parse(await readFile(join(root, 'packages/a/tsconfig.tests.json'), 'utf8'))
    assert.deepEqual(
      tests.references.map((reference: { path: string }) => reference.path),
      ['./tsconfig.json', '../provino', '../core', '../../tooling/provino'],
    )
    assert.deepEqual(tests.include, ['src/**/*.test.ts', 'provino.config.ts'])
  })

  it("writes each reference relative to the package's own directory, under packages/ and under tooling/", async () => {
    const paths = async (root: string, dir: string): Promise<string[]> =>
      JSON.parse(await readFile(join(root, dir, 'tsconfig.tests.json'), 'utf8')).references.map(
        (reference: { path: string }) => reference.path,
      )
    const files = (dir: string) => ({
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/core/package.json': '{}',
      'packages/types/package.json': '{}',
      [`${dir}/package.json`]: JSON.stringify({
        name: '@provino/under-test',
        dependencies: { '@provino/core': 'workspace:*' },
        devDependencies: { '@provino/types': 'workspace:*' },
      }),
      [`${dir}/tsconfig.json`]: JSON.stringify({ include: ['src'] }),
    })

    const inPackages = scratchDir('scaffold-under-packages', files('packages/x'))
    await scaffoldPackage(inPackages, join(inPackages, 'packages/x'))
    assert.deepEqual(await paths(inPackages, 'packages/x'), [
      './tsconfig.json',
      '../provino',
      '../core',
      '../types',
      '../../tooling/provino',
    ])

    // `../core` from tooling/x is tooling/core, which does not exist: the packages are two levels up.
    const inTooling = scratchDir('scaffold-under-tooling', files('tooling/x'))
    await scaffoldPackage(inTooling, join(inTooling, 'tooling/x'))
    assert.deepEqual(await paths(inTooling, 'tooling/x'), [
      './tsconfig.json',
      '../../packages/provino',
      '../../packages/core',
      '../../packages/types',
      '../provino',
    ])
  })

  it('proposes nothing for a tooling package whose references were written by hand', async () => {
    const root = scratchDir('scaffold-tooling-by-hand', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/core/package.json': '{}',
      'tooling/x/package.json': JSON.stringify({
        name: '@provino/x',
        dependencies: { '@provino/core': 'workspace:*' },
      }),
      'tooling/x/tsconfig.json': JSON.stringify({ include: ['src'] }),
    })
    await scaffoldPackage(root, join(root, 'tooling/x'))
    await writeFile(
      join(root, 'tooling/x/tsconfig.tests.json'),
      JSON.stringify({
        extends: '../../tooling/provino/tsconfig.tests.base.json',
        include: ['src/**/*.test.ts', 'provino.config.ts'],
        references: [
          { path: './tsconfig.json' },
          { path: '../../packages/provino' },
          { path: '../../packages/core' },
          { path: '../../tooling/provino' },
        ],
      }),
    )
    assert.deepEqual(await scaffoldPackage(root, join(root, 'tooling/x')), [])
  })

  it('gives provino no reference to itself', async () => {
    const root = scratchDir('scaffold-self', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/provino/package.json': JSON.stringify({ name: 'provino' }),
      'packages/provino/tsconfig.json': JSON.stringify({ include: ['src'] }),
    })
    await scaffoldPackage(root, join(root, 'packages/provino'))
    const tests = JSON.parse(
      await readFile(join(root, 'packages/provino/tsconfig.tests.json'), 'utf8'),
    )
    assert.deepEqual(
      tests.references.map((reference: { path: string }) => reference.path),
      ['./tsconfig.json', '../../tooling/provino'],
    )
  })

  it('adds what an existing tests project lacks', async () => {
    const root = workspace()
    await scaffoldPackage(root, join(root, 'packages/a'))
    await writeFile(
      join(root, 'packages/a/tsconfig.tests.json'),
      JSON.stringify({ include: ['src/**/*.test.ts'], references: [{ path: './tsconfig.json' }] }),
    )
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.equal(lines.length, 1)
    assert.match(
      lines[0] ?? '',
      /tsconfig\.tests\.json: extends \.\.\/\.\.\/tooling\/provino\/tsconfig\.tests\.base\.json, include provino\.config\.ts, reference \.\.\/provino, reference \.\.\/\.\.\/tooling\/provino/,
    )
  })

  it('reports test files under test/ or bench/ that no tsconfig covers, and drops options the base carries', async () => {
    const root = scratchDir('scaffold-uncovered', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      'packages/a/tsconfig.json': JSON.stringify({ include: ['src'] }),
      'packages/a/tsconfig.tests.json': JSON.stringify({
        compilerOptions: { rewriteRelativeImportExtensions: false, paths: {} },
      }),
      'packages/a/test/x.test.ts': '',
      'packages/a/bench/covered/y.test.ts': '',
      'packages/a/bench/tsconfig.json': '{}',
    })
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.ok(
      lines.some((line) =>
        /packages\/a\/test: 1 test file\(s\) and no test\/tsconfig\.json/.test(line),
      ),
      lines.join('\n'),
    )
    assert.ok(!lines.some((line) => line.includes('packages/a/bench:')), lines.join('\n'))
    const tests = JSON.parse(await readFile(join(root, 'packages/a/tsconfig.tests.json'), 'utf8'))
    assert.equal(tests.extends, '../../tooling/provino/tsconfig.tests.base.json')
    assert.deepEqual(tests.compilerOptions, { paths: {} })
  })

  it('references every workspace package in dependencies, devDependencies and peerDependencies, once, never itself', async () => {
    const root = scratchDir('scaffold-kinds', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/core/package.json': '{}',
      'packages/expect/package.json': '{}',
      'packages/types/package.json': '{}',
      'packages/a/package.json': JSON.stringify({
        name: '@provino/a',
        dependencies: { '@provino/core': 'workspace:*', '@provino/a': 'workspace:*' },
        devDependencies: { '@provino/expect': 'workspace:*', '@provino/core': 'workspace:*' },
        peerDependencies: { '@provino/types': '*' },
      }),
      'packages/a/tsconfig.json': JSON.stringify({ include: ['src'] }),
    })
    await scaffoldPackage(root, join(root, 'packages/a'))
    const tests = JSON.parse(await readFile(join(root, 'packages/a/tsconfig.tests.json'), 'utf8'))
    assert.deepEqual(
      tests.references.map((reference: { path: string }) => reference.path),
      [
        './tsconfig.json',
        '../provino',
        '../core',
        '../expect',
        '../types',
        '../../tooling/provino',
      ],
    )
  })

  it('gives the tsconfig that covers a test/ or bench/ test the provino and dependency references', async () => {
    const root = scratchDir('scaffold-test-dirs', {
      'tooling/provino/bootstrap.json': JSON.stringify({ files: {} }),
      'tsconfig.json': JSON.stringify({ references: [] }),
      'packages/core/package.json': '{}',
      'packages/types/package.json': '{}',
      'packages/a/package.json': JSON.stringify({
        name: '@provino/a',
        dependencies: { '@provino/core': 'workspace:*' },
        devDependencies: { '@provino/types': 'workspace:*' },
      }),
      'packages/a/tsconfig.json': JSON.stringify({ include: ['src'] }),
      'packages/a/test/tsconfig.json': JSON.stringify({
        include: ['.'],
        references: [{ path: '..' }, { path: '../../core' }],
      }),
      'packages/a/test/x.test.ts': '',
      'packages/a/bench/deep/tsconfig.json': JSON.stringify({ include: ['.'] }),
      'packages/a/bench/deep/more/y.test.ts': '',
    })
    const paths = async (file: string): Promise<string[]> =>
      JSON.parse(await readFile(join(root, file), 'utf8')).references?.map(
        (reference: { path: string }) => reference.path,
      )
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.deepEqual(await paths('packages/a/test/tsconfig.json'), [
      '..',
      '../../core',
      '../../provino',
      '../../types',
    ])
    assert.deepEqual(await paths('packages/a/bench/deep/tsconfig.json'), [
      '../../../provino',
      '../../../core',
      '../../../types',
    ])
    assert.ok(lines.some((line) => line.startsWith('packages/a/test/tsconfig.json: reference')))
    assert.deepEqual(await scaffoldPackage(root, join(root, 'packages/a')), [])
  })

  it('reads a tsconfig with comments and leaves it as written when nothing in it changes', async () => {
    const root = workspace()
    // Comment markers inside strings (the glob's `/*`, a URL's `//`) are text, and a trailing
    // comma is what tsc accepts.
    const text = [
      '{',
      '  "$schema": "https://json.schemastore.org/tsconfig", // a line comment',
      '  /* a block comment, with "quotes" */',
      '  "include": ["src"],',
      '  "exclude": ["src/gen", "src/**/*.test.ts",],',
      '}',
      '',
    ].join('\n')
    await writeFile(join(root, 'packages/a/tsconfig.json'), text)
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.ok(!lines.some((line) => line.startsWith('packages/a/tsconfig.json')), lines.join('\n'))
    assert.equal(await readFile(join(root, 'packages/a/tsconfig.json'), 'utf8'), text)
  })

  it('refuses to rewrite a file with comments, naming the edit to make by hand, and leaves it as written', async () => {
    const root = workspace()
    const text =
      '{\n  // why src/gen is left out\n  "include": ["src"],\n  "exclude": ["src/gen", "odd,]"]\n}\n'
    await writeFile(join(root, 'packages/a/tsconfig.json'), text)
    await assert.rejects(scaffoldPackage(root, join(root, 'packages/a')), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { code?: unknown }).code, 'MIGRATE_WRITE')
      assert.match(error.message, /packages\/a\/tsconfig\.json has comments/)
      assert.match(error.message, /exclude gained src\/\*\*\/\*\.test\.ts/)
      assert.ok(
        error.message.includes('"exclude": ["src/gen","odd,]","src/**/*.test.ts"]'),
        error.message,
      )
      return true
    })
    assert.equal(await readFile(join(root, 'packages/a/tsconfig.json'), 'utf8'), text)
    // Made by hand, the edit is the one the scaffold wanted: the next run finds nothing to change.
    await writeFile(
      join(root, 'packages/a/tsconfig.json'),
      text.replace('"odd,]"]', '"odd,]", "src/**/*.test.ts"]'),
    )
    const lines = await scaffoldPackage(root, join(root, 'packages/a'))
    assert.ok(!lines.some((line) => line.startsWith('packages/a/tsconfig.json')), lines.join('\n'))
  })

  it('finds every by-hand edit before it writes anything, and names them together (B27h3)', async () => {
    const root = workspace()
    const files = {
      'packages/a/tsconfig.json': '{\n  // a\n  "include": ["src"]\n}\n',
      'tsconfig.json': '{\n  // the root\n  "references": [{ "path": "packages/a" }]\n}\n',
    }
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
    const manifest = await readFile(join(root, 'packages/a/package.json'), 'utf8')
    await assert.rejects(scaffoldPackage(root, join(root, 'packages/a')), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'MIGRATE_WRITE')
      const message = (error as Error).message
      assert.match(message, /packages\/a\/tsconfig\.json has comments/)
      assert.match(message, /^tsconfig\.json has comments/m)
      assert.match(message, /nothing was written/)
      return true
    })
    // The config, turbo.json and the tests project are not written, and the script is unchanged.
    for (const name of ['provino.config.ts', 'turbo.json', 'tsconfig.tests.json']) {
      assert.equal(existsSync(join(root, 'packages/a', name)), false, name)
    }
    assert.equal(await readFile(join(root, 'packages/a/package.json'), 'utf8'), manifest)
    for (const [name, text] of Object.entries(files)) {
      assert.equal(await readFile(join(root, name), 'utf8'), text, name)
    }
  })

  it('stops with a coded error, writing nothing, on a file that is not JSON even without comments', async () => {
    const root = workspace()
    const text = '{ "include": ["src"] \n'
    await writeFile(join(root, 'packages/a/tsconfig.json'), text)
    await assert.rejects(scaffoldPackage(root, join(root, 'packages/a')), { code: 'MIGRATE_WRITE' })
    assert.equal(await readFile(join(root, 'packages/a/tsconfig.json'), 'utf8'), text)
  })

  it('is idempotent: a second run writes nothing', async () => {
    const root = workspace()
    await scaffoldPackage(root, join(root, 'packages/a'))
    assert.deepEqual(await scaffoldPackage(root, join(root, 'packages/a')), [])
  })

  it('leaves a package outside the workspace alone', async () => {
    const root = workspace()
    const other = workspace()
    assert.deepEqual(await scaffoldPackage(root, join(other, 'packages/a')), [])
  })
})
