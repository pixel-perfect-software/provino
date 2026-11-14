// T8.10 through the bin: `provino jest` with coverage on, against the reports real Jest 30.5.2's
// babel provider wrote for the same project (`coverage/*`, recorded with the recorder's
// `--ci --json --outputFile`): the exit code, the text reports on stdout byte for byte, lcov and
// clover byte for byte (clover's timestamps masked), `coverage-summary.json` per file and in
// total, `coverage-final.json`'s files, paths, counters and statement, function and branch maps
// (D116: the TypeScript is stripped in place), and `--json`'s `coverageMap`.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { JEST, noColorEnv } from './live-jest.ts'
import { type Json, normalizedJson, observedText } from './mask.ts'
import { loadFixture, materialize, type RecordedFixture } from './recorded.ts'
import { spawnCli } from './support.ts'

/**
 * What the recorder's environment is for the reports: `CI=1` (not `'true'`, so Jest's `getMaxCols`
 * gives no 80-column limit), no colour, no terminal width (`COLUMNS` is dropped by `runnerEnv`).
 */
const RECORDER_ENV = { CI: '1', NO_COLOR: '1', COLUMNS: '', GITHUB_ACTIONS: '' }

interface Ran {
  readonly fixture: RecordedFixture
  readonly root: string
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** A file the run wrote, by its path from the root; `null` when it wrote none. */
  file(path: string): Promise<string | null>
  /** A `json:` capture of ours, as the recorder normalizes Jest's. */
  json(path: string): Promise<Json | null>
}

const disposers: (() => Promise<void>)[] = []
after(async () => {
  await Promise.all(disposers.map((dispose) => dispose()))
})

/** Provino on the fixture's project, with the recorder's flags and the fixture's own. */
async function provinoOn(id: string): Promise<Ran> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  disposers.push(project.dispose)
  const { root } = project
  await mkdir(join(root, '.harness-out'), { recursive: true })
  // The recorder starts the runner in `run.cwd` when the fixture names one (below the root).
  const cwd = fixture.manifest.run?.cwd === undefined ? root : join(root, fixture.manifest.run.cwd)
  await mkdir(cwd, { recursive: true })
  const ended = await spawnCli(
    [
      'jest',
      `--config=${join(root, 'jest.config.json')}`,
      '--ci',
      '--json',
      `--outputFile=${join(root, '.harness-out', 'jest.json')}`,
      ...(fixture.manifest.run?.argv?.jest ?? []),
    ],
    { cwd, env: RECORDER_ENV },
  )
  const read = async (path: string): Promise<string | null> =>
    existsSync(join(root, path)) ? readFile(join(root, path), 'utf8') : null
  return {
    fixture,
    root,
    code: ended.code,
    stdout: ended.stdout,
    stderr: ended.stderr,
    file: read,
    json: async (path) => {
      const text = await read(path)
      return text === null
        ? null
        : normalizedJson(JSON.parse(text) as Json, {
            roots: [root],
            timeKeys: fixture.manifest.run?.timeKeys ?? [],
            maskKeys: fixture.manifest.run?.maskKeys,
            mask: fixture.manifest.run?.mask,
          })
    },
  }
}

/** Our stdout, or a captured file, as the recording holds it (`raw`: the root and the masks). */
function asRecorded(ran: Ran, text: string): string {
  return observedText(text, { roots: [ran.root], mask: ran.fixture.manifest.run?.mask })
}

type FileData = Readonly<Record<string, Json>>

function filesOf(value: Json | null | undefined): Readonly<Record<string, FileData>> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), 'an object')
  return value as Readonly<Record<string, FileData>>
}

/**
 * Each file's whole entry (path, counters, maps, `inputSourceMap`, `_coverageSchema`, every other
 * field) without `hash`: D111 compares the maps and counters, and `hash` is a digest of the
 * work directory's path, which the recording masks.
 */
function entries(value: Json | null | undefined): Readonly<Record<string, Json>> {
  return Object.fromEntries(
    Object.entries(filesOf(value)).map(([key, data]) => {
      const { hash: _hash, ...rest } = data
      return [key, rest]
    }),
  )
}

describe('provino jest --coverage writes the reports Jest 30.5.2 wrote (coverage/*)', () => {
  it('the sample: text, lcov, clover and json-summary byte for byte, every file counted alike (babel-providers-sample)', async () => {
    const ran = await provinoOn('coverage/babel-providers-sample')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
    for (const file of ['coverage/lcov.info', 'coverage/clover.xml']) {
      const ours = await ran.file(file)
      assert.ok(ours !== null, `${file} was written`)
      assert.equal(asRecorded(ran, ours), golden?.files?.[file], file)
    }
    assert.deepEqual(
      await ran.json('coverage/coverage-summary.json'),
      golden?.json?.['coverage/coverage-summary.json'],
    )
    const final = await ran.json('coverage/coverage-final.json')
    const expected = golden?.json?.['coverage/coverage-final.json']
    // The untested file is there, at zero, with the four that ran.
    assert.equal(Object.keys(filesOf(final)).length, 5)
    // D116: the TypeScript is stripped in place on the coverage path, so Istanbul instruments
    // code whose positions are the source's, as Jest's babel provider does (its recorder strips
    // with Node's `stripTypeScriptTypes`): the maps, counters and every other field are Jest's.
    assert.deepEqual(entries(final), entries(expected))
    // `--json`'s `coverageMap` is the same map, entry for entry.
    const results = filesOf(await ran.json('.harness-out/jest.json'))
    const recorded = filesOf(golden?.json?.['.harness-out/jest.json'])
    assert.deepEqual(entries(results.coverageMap), entries(recorded.coverageMap))
  })

  it('--coverage with the defaults: only the files the tests loaded, json, text, lcov and clover in <rootDir>/coverage (babel-defaults)', async () => {
    const ran = await provinoOn('coverage/babel-defaults')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
    for (const file of ['coverage/lcov.info', 'coverage/clover.xml']) {
      const ours = await ran.file(file)
      assert.ok(ours !== null, `${file} was written`)
      assert.equal(asRecorded(ran, ours), golden?.files?.[file], file)
    }
    assert.deepEqual(
      entries(await ran.json('coverage/coverage-final.json')),
      entries(golden?.json?.['coverage/coverage-final.json']),
    )
  })

  it('babel-jest instruments only under the process cwd: a run below the root leaves a loaded file out (babel-cwd-below-root)', async () => {
    const ran = await provinoOn('coverage/babel-cwd-below-root')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
    assert.deepEqual(
      entries(await ran.json('coverage/coverage-final.json')),
      entries(golden?.json?.['coverage/coverage-final.json']),
    )
  })

  it('coveragePathIgnorePatterns leaves a loaded file out; an untested one is at zero (babel-path-ignore)', async () => {
    const ran = await provinoOn('coverage/babel-path-ignore')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
    assert.deepEqual(
      await ran.json('coverage/coverage-summary.json'),
      golden?.json?.['coverage/coverage-summary.json'],
    )
  })

  it('no reporters under --json: nothing is written (babel-reporters-empty-json)', async () => {
    const ran = await provinoOn('coverage/babel-reporters-empty-json')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(ran.stdout, golden?.stdout)
    assert.equal(
      await ran.file('coverage/coverage-final.json'),
      golden?.files?.['coverage/coverage-final.json'],
    )
  })

  it('the counters live in globalThis.__coverage__ (istanbul-variable)', async () => {
    const ran = await provinoOn('coverage/istanbul-variable')
    const golden = ran.fixture.golden.observed
    assert.equal(ran.code, golden?.exitCode, ran.stderr)
    assert.equal(ran.code, 0, 'both tests that read the global pass')
    assert.equal(asRecorded(ran, ran.stdout), golden?.stdout)
  })
})

describe('provino jest --coverage beside a live Jest 30.5.2', () => {
  it('coverageReporters [] without --json prints the text-summary fallback on stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-fallback-'))
    disposers.push(() => rm(dir, { recursive: true, force: true }))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}\n')
    await writeFile(
      join(dir, 'src', 'add.js'),
      'exports.add = (a, b) => (a > 0 ? a + b : b)\nexports.never = () => 0\n',
    )
    await writeFile(
      join(dir, 'add.test.js'),
      "const { add } = require('./src/add')\ntest('adds', () => { expect(add(1, 2)).toBe(3) })\n",
    )
    await writeFile(
      join(dir, 'jest.config.json'),
      JSON.stringify({ collectCoverage: true, coverageReporters: [] }),
    )
    const jest = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, [JEST, '--ci'], {
          cwd: dir,
          env: { ...noColorEnv(), ...RECORDER_ENV },
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, stdout }))
      }, reject)
    })
    assert.match(jest.stdout, /Coverage summary/)
    await rm(join(dir, 'coverage'), { recursive: true, force: true })
    const ours = await spawnCli(['jest', '--ci'], { cwd: dir, env: RECORDER_ENV })
    assert.equal(ours.code, jest.code, ours.stderr)
    assert.equal(ours.stdout, jest.stdout)
  })
})

/** A project for the live comparisons: two modules, one test that loads one of them. */
const LIVE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{"type":"commonjs"}\n',
  'src/add.js': 'exports.add = (a, b) => (a > 0 ? a + b : b)\nexports.never = () => 0\n',
  'src/unused.js': 'exports.unused = (x) => (x ? 1 : 2)\n',
  'src/generated/gen.js': 'exports.gen = () => 1\n',
  'src/empty.js': '// nothing to count\n',
  'add.test.js':
    "const { add } = require('./src/add')\ntest('adds', () => { expect(add(1, 2)).toBe(3) })\n",
}

interface LiveCase {
  readonly name: string
  /** The Jest config, written as `jest.config.json` in the project's root. */
  readonly config: Readonly<Record<string, unknown>>
  readonly args?: readonly string[]
  /** Files over `LIVE_FILES` (a path to `null` leaves it out). */
  readonly files?: Readonly<Record<string, string | null>>
  /** The directory both runners start in, from the root (default the root). */
  readonly cwd?: string
  /** What of stdout is compared (default all of it). */
  readonly stdout?: (text: string) => string
}

interface LiveRun {
  readonly code: number | null
  readonly stdout: string
  /** Every file under the project the run wrote, by its path from the root, sorted. */
  readonly written: readonly string[]
  /**
   * The text reports among them (`.info`, `.txt`) with the root as `<root>`, and the JSON ones
   * parsed, each file entry without its `hash` (D111: a digest of the absolute path).
   */
  readonly reports: Readonly<Record<string, Json>>
}

/** A JSON report with each coverage entry's `hash` left out, wherever it is. */
function withoutHashes(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutHashes)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'hash')
        .map(([key, inner]) => [key, withoutHashes(inner)]),
    )
  }
  return value
}

/** The project's files by their path from `root`, any `node_modules` (the caches) left out. */
async function filesUnder(root: string): Promise<Set<string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .filter((path) => !/(?:^|\/)node_modules\//.test(path)),
  )
}

async function liveProject(spec: LiveCase): Promise<string> {
  // One name for both runners' copies: the text report prints the root directory's name.
  const parent = await mkdtemp(join(tmpdir(), 'provino-coverage-live-'))
  disposers.push(() => rm(parent, { recursive: true, force: true }))
  const dir = join(parent, 'project')
  const files = { ...LIVE_FILES, ...spec.files }
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  await writeFile(join(dir, 'jest.config.json'), JSON.stringify(spec.config))
  await mkdir(join(dir, spec.cwd ?? '.'), { recursive: true })
  return dir
}

/** One runner on a fresh copy of the case's project: exit code, stdout, the files it wrote. */
async function runLive(spec: LiveCase, runner: 'jest' | 'provino'): Promise<LiveRun> {
  const root = await liveProject(spec)
  const before = await filesUnder(root)
  const cwd = join(root, spec.cwd ?? '.')
  const args = ['--ci', `--config=${join(root, 'jest.config.json')}`, ...(spec.args ?? [])]
  let code: number | null
  let stdout: string
  if (runner === 'jest') {
    const { spawn } = await import('node:child_process')
    ;({ code, stdout } = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [JEST, ...args], {
          cwd,
          env: { ...noColorEnv(), ...RECORDER_ENV },
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        let text = ''
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString()
        })
        child.once('error', reject)
        child.once('close', (exit) => resolve({ code: exit, stdout: text }))
      },
    ))
  } else {
    ;({ code, stdout } = await spawnCli(['jest', ...args], { cwd, env: RECORDER_ENV }))
  }
  const written = [...(await filesUnder(root))].filter((path) => !before.has(path)).sort()
  const reports: Record<string, Json> = {}
  for (const path of written) {
    if (!/\.(?:json|info|txt)$/.test(path)) continue
    const text = (await readFile(join(root, path), 'utf8')).replaceAll(root, '<root>')
    reports[path] = path.endsWith('.json') ? withoutHashes(JSON.parse(text) as Json) : text
  }
  const shown = spec.stdout ?? ((text: string) => text)
  return { code, stdout: shown(stdout.replaceAll(root, '<root>')), written, reports }
}

/** `--json`'s results, which carry times, left out of stdout: the line that is one JSON object. */
const withoutJsonLine = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('{"numFailedTestSuites"'))
    .join('\n')

const LIVE_CASES: readonly LiveCase[] = [
  {
    name: '--coverage=false over collectCoverage: true collects nothing',
    config: { collectCoverage: true, coverageReporters: ['text-summary', 'json'] },
    args: ['--coverage=false'],
  },
  {
    name: '--collectTests with coverage on runs no test and writes no report',
    config: { collectCoverage: true, coverageReporters: ['text-summary', 'json'] },
    args: ['--collectTests'],
  },
  {
    name: 'reporter option tuples: text with skipEmpty, lcov with projectRoot',
    config: {
      collectCoverage: true,
      collectCoverageFrom: ['src/**/*.js'],
      coverageReporters: [
        ['text', { skipEmpty: true }],
        ['lcov', { projectRoot: '..' }],
      ],
    },
  },
  {
    name: 'forceCoverageMatch counts a test file',
    config: {
      collectCoverage: true,
      forceCoverageMatch: ['**/*.test.js'],
      coverageReporters: ['text', 'json'],
    },
  },
  {
    name: 'coverageDirectory is relative to rootDir when the cwd differs',
    config: {
      collectCoverage: true,
      coverageDirectory: 'out/cov',
      coverageReporters: ['json', 'text-summary'],
      roots: ['<rootDir>/sub'],
    },
    files: {
      'sub/src/add.js': 'exports.add = (a, b) => (a > 0 ? a + b : b)\n',
      'sub/add.test.js':
        "const { add } = require('./src/add')\ntest('adds', () => { expect(add(1, 2)).toBe(3) })\n",
      'add.test.js': null,
    },
    cwd: 'sub',
  },
  {
    name: "--json with ['text'] and no --outputFile: the text report and the results on stdout",
    config: { collectCoverage: true, coverageReporters: ['text'] },
    args: ['--json'],
    stdout: withoutJsonLine,
  },
  {
    name: 'collectCoverageFrom negations',
    config: {
      collectCoverage: true,
      collectCoverageFrom: ['src/**/*.js', '!src/generated/**', '!**/unused.js'],
      coverageReporters: ['text', 'json'],
    },
  },
]

describe('provino jest --coverage beside a live Jest 30.5.2, case by case', () => {
  for (const spec of LIVE_CASES) {
    it(spec.name, async () => {
      const jest = await runLive(spec, 'jest')
      const ours = await runLive(spec, 'provino')
      assert.equal(ours.code, jest.code)
      assert.equal(ours.stdout, jest.stdout)
      assert.deepEqual(ours.written, jest.written)
      assert.deepEqual(ours.reports, jest.reports)
    })
  }

  // Jest's v8 provider is T8.12's: Provino says so and collects nothing (a declared gap, not a
  // match: Jest writes its v8 reports).
  it('coverageProvider v8 is not applied yet, and says so (T8.12)', async () => {
    const spec: LiveCase = {
      name: 'v8',
      config: { collectCoverage: true, coverageProvider: 'v8', coverageReporters: ['json'] },
    }
    const root = await liveProject(spec)
    const ran = await spawnCli(['jest', '--ci', `--config=${join(root, 'jest.config.json')}`], {
      cwd: root,
      env: RECORDER_ENV,
    })
    assert.equal(ran.code, 0, ran.stderr)
    assert.match(ran.stderr, /coverageProvider[\s\S]*T8\.12/)
    assert.equal(existsSync(join(root, 'coverage')), false)
  })
})
