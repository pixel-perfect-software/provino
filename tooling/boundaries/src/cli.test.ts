import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'provino'
import { scratchDir } from './test-support.ts'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))

interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(...args: string[]): Promise<Result> {
  const { FORCE_COLOR: _force, ...env } = process.env
  return new Promise((resolve, reject) => {
    // FORCE_COLOR would win over NO_COLOR for dependency-cruiser and colour the output.
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, NO_COLOR: '1' } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

const exportsOf = {
  '.': {
    'provino-source': './src/index.ts',
    types: './dist/index.d.ts',
    import: './dist/index.js',
  },
}

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
  const pkg = (name: string, dependencies: Record<string, string> = {}): string =>
    JSON.stringify({ name, type: 'module', exports: exportsOf, dependencies })
  const dir = await scratchDir('cli', {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: 'packages/low' }, { path: 'packages/high' }],
    }),
    'tsconfig.type-tests.json': JSON.stringify({ files: [], references: [] }),
    'tooling/boundaries/packages.json': JSON.stringify(manifest),
    'packages/low/package.json': pkg('@fixture/low'),
    'packages/low/src/index.ts': 'export const low = 1\n',
    'packages/high/package.json': pkg('@fixture/high', { '@fixture/low': 'workspace:*' }),
    'packages/high/src/index.ts':
      "import { low } from '@fixture/low'\nexport const high = low + 1\n",
  })
  const link = join(dir, 'node_modules/@fixture/low')
  await mkdir(dirname(link), { recursive: true })
  await symlink(join(dir, 'packages/low'), link, 'dir')
  return dir
}

test('`check` passes on a repo that agrees and says what agreed', async () => {
  const dir = await repo()
  const written = await run('write', '--root', dir)
  assert.equal(written.status, 0, written.stderr + written.stdout)
  assert.match(written.stdout, /wrote \.dependency-cruiser\.json/)
  const result = await run('check', '--root', dir)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /no dependency violations found/)
  assert.match(
    result.stdout,
    /boundaries: manifest, workspace, generated files and dependencies agree/,
  )
})

test('`check` fails on that repo once an import goes up a layer, and says nothing agreed', async () => {
  const dir = await repo()
  assert.equal((await run('write', '--root', dir)).status, 0)
  await writeFile(join(dir, 'packages/low/src/up.ts'), "export * from '../../high/src/index.ts'\n")
  const result = await run('check', '--root', dir)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /error boundary-@fixture-low: packages\/low\/src\/up\.ts/)
  assert.doesNotMatch(result.stdout, /agree/)
})

test('an unknown mode exits 2 with usage', async () => {
  const result = await run('lint')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: node tooling\/boundaries\/src\/cli\.ts check\|write/)
})

test('`--root` without a directory, or another flag, exits 2 with usage', async () => {
  for (const args of [
    ['check', '--root'],
    ['check', '--base', 'x'],
  ]) {
    const result = await run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /check\|write \[--root <dir>\]/)
  }
})
