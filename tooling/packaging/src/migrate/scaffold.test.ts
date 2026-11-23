import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { TEST_RUNNER } from '../dogfood.ts'
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

  it('stops with a coded error, writing nothing, on a tsconfig with comments', async () => {
    const root = workspace()
    const text = '{ // note\n "include": ["src"] }\n'
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
