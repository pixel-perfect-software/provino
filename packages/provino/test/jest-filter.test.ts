// T9.9 (B23d, A3): `--filter`. The config's `filter` (or the flag) names a CommonJS module, loaded in the
// coordinator with a plain `require` as `runCLI` does; its `setup` runs once, and the function is
// called with each project's test paths and returns `{ filtered }`, the ones that run. Held to
// `cli/filter`, `cli/filter-invalid` and `cli/filter-list-tests` (recorded from Jest 30.5.2) and to a
// live Jest for `--listTests --filter`, `--skipFilter` and a filter whose setup rejects.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { JEST, noColorEnv } from './live-jest.ts'
import { loadFixture, materialize, underRoot } from './recorded.ts'
import { spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

function kept(text: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return text.split('\n').filter((line) => keep.test(line))
}

describe('provino jest --filter against the recorded Jest 30.5.2 runs', () => {
  it('cli/filter: the filter runs once with the absolute paths, setup first, and the dropped file never runs', async () => {
    const fixture = await loadFixture('cli/filter')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci'],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const keepLines = fixture.manifest.run?.keepLines ?? ''
      assert.deepEqual(
        kept(ended.stderr, keepLines),
        kept(fixture.golden.observed?.stderr ?? '', keepLines),
      )
      assert.equal(
        await readFile(join(project.root, 'calls.txt'), 'utf8'),
        fixture.golden.observed?.files?.['calls.txt'],
      )
    } finally {
      await project.dispose()
    }
  })

  it('cli/filter-invalid: no list is a TypeError, its stack on stderr, exit 1, and nothing runs', async () => {
    const fixture = await loadFixture('cli/filter-invalid')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci'],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const keepLines = fixture.manifest.run?.keepLines ?? ''
      assert.deepEqual(
        kept(underRoot(ended.stderr, project.root), keepLines),
        kept(fixture.golden.observed?.stderr ?? '', keepLines),
      )
    } finally {
      await project.dispose()
    }
  })

  it('cli/filter-list-tests: --listTests lists what the filter kept', async () => {
    const fixture = await loadFixture('cli/filter-list-tests')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--listTests', '--json'],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const listed = (JSON.parse(ended.stdout) as string[]).map((path) =>
        underRoot(path, project.root),
      )
      assert.equal(
        listed.sort().join('\n'),
        fixture.golden.observed?.files?.['.harness-out/jest.json'],
      )
    } finally {
      await project.dispose()
    }
  })
})

/** Both runners' stdout and exit code on `args`, in `cwd`. */
function stdoutOf(
  command: readonly string[],
  cwd: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, {
      cwd,
      env: noColorEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-filter-')))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const FILES = {
  'package.json': '{"type":"commonjs"}\n',
  'jest.config.json': '{"testMatch":["<rootDir>/*.test.js"]}\n',
  'a.test.js': "test('a', () => {})\n",
  'b.test.js': "test('b', () => {})\n",
  'c.test.js': "test('c', () => {})\n",
  // Keeps only b, whatever the order of the paths it is given.
  'only-b.cjs':
    "module.exports = (tests) => ({ filtered: tests.filter((t) => t.endsWith('b.test.js')) })\n",
  'setup-rejects.cjs':
    "module.exports = (tests) => ({ filtered: tests })\nmodule.exports.setup = async () => { throw new Error('setup failed') }\n",
  'no-such-list.cjs': 'module.exports = () => undefined\n',
}

describe('provino jest --filter against a live Jest 30.5.2', () => {
  const lines = (stdout: string): string[] => stdout.split('\n').filter(Boolean).sort()

  it('--listTests --filter lists the same files, and --skipFilter lists them all', async () => {
    const root = await tree(FILES)
    for (const extra of [
      ['--filter', './only-b.cjs'],
      ['--filter', join(root, 'only-b.cjs'), '--skipFilter'],
    ]) {
      const args = ['--listTests', ...extra]
      const jest = await stdoutOf([JEST, ...args], root)
      const provino = await spawnCli(['jest', ...args], { cwd: root })
      assert.equal(provino.code, jest.code, provino.stderr)
      assert.deepEqual(lines(provino.stdout), lines(jest.stdout), extra.join(' '))
    }
    const listed = lines(
      (await stdoutOf([JEST, '--listTests', '--filter', './only-b.cjs'], root)).stdout,
    )
    assert.deepEqual(
      listed.map((path) => path.replace(root, '')),
      ['/b.test.js'],
    )
  })

  it('a filter whose setup rejects ends the run with that error, as Jest does', async () => {
    const root = await tree(FILES)
    const jest = await stdoutOf([JEST, '--filter', './setup-rejects.cjs'], root)
    const provino = await spawnCli(['jest', '--filter', './setup-rejects.cjs'], { cwd: root })
    assert.equal(provino.code, jest.code)
    assert.equal(provino.code, 1)
    assert.match(provino.stderr, /^Error: setup failed$/m)
    assert.match(jest.stderr, /^Error: setup failed$/m)
    assert.doesNotMatch(provino.stderr, /^PASS /m)
  })

  it('a filter that returns nothing usable is Jest`s TypeError', async () => {
    const root = await tree(FILES)
    const jest = await stdoutOf([JEST, '--filter', './no-such-list.cjs'], root)
    const provino = await spawnCli(['jest', '--filter', './no-such-list.cjs'], { cwd: root })
    assert.equal(provino.code, jest.code)
    const first = (text: string): string | undefined =>
      text.split('\n').find((line) => line.startsWith('TypeError'))
    assert.equal(first(provino.stderr), first(jest.stderr))
  })
})
