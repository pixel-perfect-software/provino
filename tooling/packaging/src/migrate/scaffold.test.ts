import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
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
    assert.equal(written.length, 6)
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
