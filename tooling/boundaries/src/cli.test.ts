import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'provino'
import { linkPackages, type RunResult, runNode, scratchDir } from './test-support.ts'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))

const run = (...args: string[]): Promise<RunResult> => runNode(cli, args)

/**
 * A two-package repo the CLI can check in a second: a manifest, the workspace files every check
 * reads, and one import between the packages, resolved through node_modules as pnpm links it. The
 * repo's own tree is checked by `pnpm boundaries` in CI's "Lint, format and boundaries" job.
 */
async function repo(): Promise<string> {
  const manifest = {
    slices: {},
    wholePolicyTypes: [],
    wholePolicyValues: [],
    nodes: {
      '@fixture/low': { dir: 'packages/low', layer: 0, runsIn: 'both', deps: [], slices: [] },
      '@fixture/high': {
        dir: 'packages/high',
        layer: 1,
        runsIn: 'both',
        deps: ['@fixture/low'],
        slices: [],
      },
    },
  }
  const dir = await scratchDir('cli', {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: 'packages/low' }, { path: 'packages/high' }],
    }),
    'tsconfig.type-tests.json': JSON.stringify({ files: [], references: [] }),
    'tooling/boundaries/packages.json': JSON.stringify(manifest),
  })
  await linkPackages(dir, ['@fixture/low', '@fixture/high'], {
    '@fixture/high': ['@fixture/low'],
  })
  return dir
}

// Every case has its own scratch dir (or none), so the cases run at once.
describe.concurrent('the boundaries CLI', () => {
  test('`check` passes on a repo that agrees and says what agreed', async () => {
    const dir = await repo()
    const written = await run('write', '--root', dir)
    assert.equal(written.code, 0, written.stderr + written.stdout)
    assert.match(written.stdout, /wrote \.dependency-cruiser\.json/)
    const result = await run('check', '--root', dir)
    assert.equal(result.code, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /no dependency violations found/)
    assert.match(
      result.stdout,
      /boundaries: manifest, workspace, generated files and dependencies agree/,
    )
  })

  test('`check` fails on that repo once an import goes up a layer, and says nothing agreed', async () => {
    const dir = await repo()
    assert.equal((await run('write', '--root', dir)).code, 0)
    await writeFile(
      join(dir, 'packages/low/src/up.ts'),
      "export * from '../../high/src/index.ts'\n",
    )
    const result = await run('check', '--root', dir)
    assert.equal(result.code, 1, result.stderr + result.stdout)
    assert.match(result.stdout, /error boundary-@fixture-low: packages\/low\/src\/up\.ts/)
    assert.doesNotMatch(result.stdout, /agree/)
  })

  test('an unknown mode, no mode or an extra word exits 2 with usage', async () => {
    const lines = [['lint'], [], ['check', 'write'], ['check', 'x']]
    const results = await Promise.all(lines.map((args) => run(...args)))
    results.forEach((result, index) => {
      assert.equal(result.code, 2, `${JSON.stringify(lines[index])}`)
      assert.match(result.stderr, /usage: node tooling\/boundaries\/src\/cli\.ts check\|write/)
    })
  })

  test('`--root` without a directory, or another flag, exits 2 with usage', async () => {
    const lines = [
      ['check', '--root'],
      ['check', '--base', 'x'],
    ]
    const results = await Promise.all(lines.map((args) => run(...args)))
    results.forEach((result, index) => {
      assert.equal(result.code, 2, lines[index]?.join(' '))
      assert.match(result.stderr, /check\|write \[--root <dir>\]/)
    })
  })
})
