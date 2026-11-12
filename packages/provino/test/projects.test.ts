// D29: `provino jest` runs a config's `projects` in one pool, as Jest does. Two shapes the R6 repos
// use: mobx's (a root config listing each package's own config file by glob) and react-hook-form's
// (inline project objects, each with a `displayName`). Each is run by real Jest 30.5.2 beside
// Provino, on the same temp tree, and every test's status, the exit code and `--listTests` (as a
// set: Jest orders its list by file size and timings) must be equal. The recorder refuses a
// `projects` key, so the oracle is run here rather than recorded.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnCli, viewOfNormalized } from './support.ts'

const JEST: string = createRequire(
  fileURLToPath(new URL('../../harness/package.json', import.meta.url)),
).resolve('jest/bin/jest')

/**
 * `runJestCommand`, loaded by URL: the type-test project includes this directory but not the
 * package's source, and the command has no flag for a reporter yet (T11.9).
 */
const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: Writable
      stderr: Writable
      cwd: string
      reporters: readonly (readonly ['normalized-json', { outputFile: string }])[]
    },
  ): Promise<number>
}

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-projects-')))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const pass = (name: string): string => `test('${name}', () => { expect(1).toBe(1) })\n`
const fail = (name: string): string => `test('${name}', () => { expect(1).toBe(2) })\n`
const skip = (name: string): string => `test.skip('${name}', () => {})\n`

/** The files of both shapes, as a project's config and test files. */
const MOBX_SHAPED: Readonly<Record<string, string>> = {
  'package.json': '{"type":"commonjs"}\n',
  // A glob, as mobx lists its packages' configs.
  'jest.config.json': JSON.stringify({ projects: ['<rootDir>/packages/*/jest.config.json'] }),
  'packages/mobx/jest.config.json': JSON.stringify({
    testMatch: ['<rootDir>/__tests__/**/*.test.js'],
  }),
  'packages/mobx/__tests__/a.test.js': pass('observes') + pass('computes'),
  'packages/mobx/__tests__/shared.test.js': pass('same name in two packages'),
  'packages/mobx-utils/jest.config.json': JSON.stringify({
    testMatch: ['<rootDir>/__tests__/**/*.test.js'],
  }),
  'packages/mobx-utils/__tests__/b.test.js': pass('utility') + fail('breaks') + skip('later'),
  'packages/mobx-utils/__tests__/shared.test.js': pass('same name in two packages'),
  'packages/mobx-react/jest.config.json': JSON.stringify({
    testMatch: ['<rootDir>/src/**/*.test.js'],
    setupFilesAfterEnv: ['<rootDir>/setup.js'],
  }),
  'packages/mobx-react/setup.js': 'globalThis.__setupRan = true\n',
  'packages/mobx-react/src/c.test.js':
    "test('sees its own setup', () => { expect(globalThis.__setupRan).toBe(true) })\n",
}

const RHF_SHAPED: Readonly<Record<string, string>> = {
  'package.json': '{"type":"commonjs"}\n',
  // Inline projects with a displayName, as react-hook-form's config has.
  'jest.config.json': JSON.stringify({
    projects: [
      { displayName: 'server', testMatch: ['<rootDir>/server/**/*.test.js'] },
      { displayName: 'client', testMatch: ['<rootDir>/client/**/*.test.js'] },
    ],
  }),
  'server/a.test.js': pass('serves') + pass('routes'),
  'client/b.test.js': pass('renders') + fail('breaks'),
  'client/c.test.js': skip('later') + pass('hydrates'),
}

const SHAPES: readonly (readonly [string, Readonly<Record<string, string>>, number])[] = [
  ['mobx-shaped (globbed config paths)', MOBX_SHAPED, 5],
  ['react-hook-form-shaped (inline projects with displayName)', RHF_SHAPED, 3],
]

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Real Jest: each test's status by `<file>::<full name>`, the exit code and the listed files. */
async function jest(dir: string): Promise<{
  code: number | null
  statuses: Map<string, string>
  listed: string[]
}> {
  const out = join(dir, '.out-jest.json')
  const ran = await run(
    process.execPath,
    [JEST, '--no-cache', '--ci', '--json', `--outputFile=${out}`],
    dir,
  )
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }
  const statuses = new Map<string, string>()
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      statuses.set(`${relative(dir, file.name)}::${test.fullName}`, test.status)
    }
  }
  const list = await run(process.execPath, [JEST, '--listTests', '--json'], dir)
  return { code: ran.code, statuses, listed: (JSON.parse(list.stdout) as string[]).sort() }
}

/** Provino: the same, through `runJestCommand` with the normalized-json reporter. */
async function provino(
  dir: string,
  cache = false,
): Promise<{
  code: number
  statuses: Map<string, string>
  stderr: string
}> {
  const out = join(dir, '.out-provino.json')
  const stderr = new Sink()
  const code = await runJestCommand(cache ? ['--ci'] : ['--no-cache', '--ci'], {
    stdout: new Sink(),
    stderr,
    cwd: dir,
    reporters: [['normalized-json', { outputFile: out }]],
  })
  const view = viewOfNormalized(await readFile(out, 'utf8'))
  const statuses = new Map<string, string>()
  const word: Readonly<Record<string, string>> = { skipped: 'pending' }
  for (const [file, entry] of view.files) {
    const path = file.startsWith('/') ? relative(dir, file) : file
    for (const [name, status] of entry.tests) {
      statuses.set(
        `${path}::${name.replaceAll(' > ', ' ')}`,
        word[String(status)] ?? String(status),
      )
    }
  }
  return { code, statuses, stderr: stderr.text }
}

/** The files in every `node_modules/.cache/provino/t` shard under `dir`. */
async function transformCacheEntries(dir: string): Promise<number> {
  let count = 0
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (path.includes(`${sep}.cache${sep}provino${sep}t${sep}`)) count++
    }
  }
  await walk(dir).catch(() => undefined)
  return count
}

describe('provino jest runs the projects of a config in one pool, as Jest does', () => {
  for (const [name, files, count] of SHAPES) {
    it(`${name}: every test has Jest's status, and the exit code is Jest's`, async () => {
      const dir = await tree(files)
      const expected = await jest(dir)
      assert.equal(expected.code, 1, 'real Jest fails the fixture (one test breaks on purpose)')
      assert.ok(expected.statuses.size >= 5)
      const got = await provino(dir)
      assert.equal(got.code, expected.code, got.stderr)
      assert.deepEqual(
        [...got.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
        [...expected.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    })

    it(`${name}: --listTests is the set Jest lists`, async () => {
      const dir = await tree(files)
      const expected = await jest(dir)
      const listed = await spawnCli(['jest', '--listTests'], { cwd: dir })
      assert.equal(listed.code, 0, listed.stderr)
      assert.deepEqual(listed.stdout.trim().split('\n').sort(), expected.listed)
      assert.equal(expected.listed.length, count)
    })
  }

  for (const [name, files] of SHAPES) {
    it(`${name}: a second run, served from the transform cache, has the same statuses`, async () => {
      const dir = await tree(files)
      const expected = await jest(dir)
      const cold = await provino(dir, true)
      const entries = await transformCacheEntries(dir)
      assert.ok(entries > 0, 'the first run filled the transform cache')
      const warm = await provino(dir, true)
      assert.equal(await transformCacheEntries(dir), entries, 'the second run added nothing')
      for (const ran of [cold, warm]) {
        assert.equal(ran.code, expected.code, ran.stderr)
        assert.deepEqual(
          [...ran.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
          [...expected.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      }
    })
  }

  it('--no-cache writes no transform cache', async () => {
    const dir = await tree(RHF_SHAPED)
    await provino(dir)
    assert.equal(await transformCacheEntries(dir), 0)
  })

  it('prints each project’s display name before its files, and runs through the bin', async () => {
    const dir = await tree(RHF_SHAPED)
    const ended = await spawnCli(['jest', '--no-cache', '--ci'], { cwd: dir })
    assert.equal(ended.code, 1, ended.stderr)
    assert.match(ended.stderr, /PASS server server\/a\.test\.js/)
    assert.match(ended.stderr, /FAIL client client\/b\.test\.js/)
    assert.match(ended.stderr, /PASS client client\/c\.test\.js/)
    assert.match(ended.stderr, /Test Suites: 1 failed, 2 passed, 3 total/)
  })

  it('maxWorkers is one cap for every project', async () => {
    const dir = await tree(MOBX_SHAPED)
    const ended = await spawnCli(['jest', '--no-cache', '--ci', '--maxWorkers=1'], { cwd: dir })
    assert.equal(ended.code, 1, ended.stderr)
    assert.match(ended.stderr, /Test Suites: 1 failed, 4 passed, 5 total/)
  })
})

/** The RHF shape plus a project with no `displayName`, and (for the plural) a second. */
const RHF_WITH_UNNAMED: Readonly<Record<string, string>> = {
  'package.json': '{"type":"commonjs"}\n',
  'jest.config.json': JSON.stringify({
    projects: [
      { displayName: 'server', testMatch: ['<rootDir>/server/**/*.test.js'] },
      { displayName: 'client', testMatch: ['<rootDir>/client/**/*.test.js'] },
      { testMatch: ['<rootDir>/other/**/*.test.js'] },
    ],
  }),
  'server/a.test.js': pass('serves') + pass('routes'),
  'client/b.test.js': pass('renders') + fail('breaks'),
  'client/c.test.js': skip('later') + pass('hydrates'),
  'other/d.test.js': pass('unnamed'),
}

const TWO_UNNAMED: Readonly<Record<string, string>> = {
  ...RHF_WITH_UNNAMED,
  'jest.config.json': JSON.stringify({
    projects: [
      { displayName: 'server', testMatch: ['<rootDir>/server/**/*.test.js'] },
      { testMatch: ['<rootDir>/client/**/*.test.js'] },
      { testMatch: ['<rootDir>/other/**/*.test.js'] },
    ],
  }),
}

/** Real Jest with `args`: its exit code, the two streams, and (from a `--json` run) the statuses. */
async function jestWith(
  dir: string,
  args: readonly string[],
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  statuses: Map<string, string>
}> {
  const plain = await run(process.execPath, [JEST, '--no-cache', '--ci', ...args], dir)
  const out = join(dir, '.out-select.json')
  await rm(out, { force: true })
  // A listing has no results to read.
  if (!args.includes('--listTests')) {
    await run(
      process.execPath,
      [JEST, '--no-cache', '--ci', '--json', `--outputFile=${out}`, ...args],
      dir,
    )
  }
  const statuses = new Map<string, string>()
  const text = await readFile(out, 'utf8').catch(() => undefined)
  if (text !== undefined) {
    const report = JSON.parse(text) as {
      testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
    }
    for (const file of report.testResults) {
      for (const test of file.assertionResults) {
        statuses.set(`${relative(dir, file.name)}::${test.fullName}`, test.status)
      }
    }
  }
  return { code: plain.code, stdout: plain.stdout, stderr: plain.stderr, statuses }
}

/** Provino with `args`: exit code, stdout (the selection text), stderr and the statuses it wrote. */
async function provinoWith(
  dir: string,
  args: readonly string[],
): Promise<{
  code: number
  stdout: string
  stderr: string
  statuses: Map<string, string>
}> {
  const out = join(dir, '.out-provino-select.json')
  await rm(out, { force: true })
  const stdout = new Sink()
  const stderr = new Sink()
  const code = await runJestCommand(['--no-cache', '--ci', ...args], {
    stdout,
    stderr,
    cwd: dir,
    reporters: [['normalized-json', { outputFile: out }]],
  })
  const statuses = new Map<string, string>()
  const text = await readFile(out, 'utf8').catch(() => undefined)
  if (text !== undefined) {
    const word: Readonly<Record<string, string>> = { skipped: 'pending' }
    for (const [file, entry] of viewOfNormalized(text).files) {
      const path = file.startsWith('/') ? relative(dir, file) : file
      for (const [name, status] of entry.tests) {
        statuses.set(
          `${path}::${name.replaceAll(' > ', ' ')}`,
          word[String(status)] ?? String(status),
        )
      }
    }
  }
  return { code, stdout: stdout.text, stderr: stderr.text, statuses }
}

const SELECTIONS: readonly (readonly [
  string,
  Readonly<Record<string, string>>,
  readonly string[],
])[] = [
  ['--selectProjects one name', RHF_SHAPED, ['--selectProjects', 'server']],
  ['--selectProjects two names', RHF_SHAPED, ['--selectProjects', 'server', 'client']],
  ['--ignoreProjects one name', RHF_SHAPED, ['--ignoreProjects', 'server']],
  ['--selectProjects with an unnamed project', RHF_WITH_UNNAMED, ['--selectProjects', 'server']],
  [
    '--ignoreProjects keeps an unnamed project',
    RHF_WITH_UNNAMED,
    ['--ignoreProjects', 'server', 'client'],
  ],
  ['two unnamed projects', TWO_UNNAMED, ['--ignoreProjects', 'server']],
  [
    '--selectProjects and --ignoreProjects',
    RHF_SHAPED,
    ['--selectProjects', 'server', 'client', '--ignoreProjects', 'client'],
  ],
  ['--selectProjects a name nobody has', RHF_SHAPED, ['--selectProjects', 'nope']],
  ['--ignoreProjects every project', RHF_SHAPED, ['--ignoreProjects', 'server', 'client']],
  [
    '--selectProjects and --ignoreProjects with nothing left',
    RHF_SHAPED,
    ['--selectProjects', 'server', '--ignoreProjects', 'server'],
  ],
  [
    'nothing selected, with --passWithNoTests',
    RHF_SHAPED,
    ['--selectProjects', 'nope', '--passWithNoTests'],
  ],
  ['nothing selected, with a path pattern', RHF_SHAPED, ['--selectProjects', 'nope', 'a.test']],
  ['a selection with --listTests', RHF_SHAPED, ['--selectProjects', 'client', '--listTests']],
  [
    'a selection with --listTests --json (the messages go to stderr)',
    RHF_SHAPED,
    ['--ignoreProjects', 'client', '--listTests', '--json'],
  ],
  ['a selection that names a project twice', RHF_SHAPED, ['--selectProjects', 'server', 'server']],
]

describe('--selectProjects and --ignoreProjects (D69) against Jest 30.5.2', () => {
  for (const [name, files, args] of SELECTIONS) {
    it(`${name}: statuses, messages and exit code are Jest's`, async () => {
      const dir = await tree(files)
      const expected = await jestWith(dir, args)
      const got = await provinoWith(dir, args)
      assert.equal(got.code, expected.code, got.stderr)
      assert.equal(got.stdout, expected.stdout)
      // Jest's own diagnostics for the selection go to the stream that carries them: stderr under
      // `--json`, stdout otherwise; the tests' output is not part of this check.
      if (args.includes('--json')) {
        for (const line of got.stderr.split('\n').filter((l) => l !== '')) {
          assert.ok(expected.stderr.includes(line), `Jest's stderr has "${line}"`)
        }
      }
      assert.deepEqual(
        [...got.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
        [...expected.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    })
  }

  it('an empty selection is refused with Jest’s text and exit code', async () => {
    const dir = await tree(RHF_SHAPED)
    const expected = await run(process.execPath, [JEST, '--selectProjects'], dir)
    const got = await provinoWith(dir, ['--selectProjects'])
    assert.equal(got.code, expected.code)
    assert.ok(got.stderr.length > 0)
  })

  it('--projects stays refused', async () => {
    const dir = await tree(RHF_SHAPED)
    const got = await provinoWith(dir, ['--projects', 'server'])
    assert.equal(got.code, 1)
    assert.match(got.stderr, /--projects is not supported yet/)
  })
})
