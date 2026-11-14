// T8.10 through the bin: `provino jest` with coverage on, against the reports real Jest 30.5.2's
// babel provider wrote for the same project (`coverage/*`, recorded with the recorder's
// `--ci --json --outputFile`): the exit code, the text reports on stdout byte for byte, lcov and
// clover byte for byte (clover's timestamps masked), `coverage-summary.json` per file and in
// total, `coverage-final.json`'s files, paths and counters, and `--json`'s `coverageMap`. The
// statement, function and branch maps are compared on their own (see the `todo` below).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const ended = await spawnCli(
    [
      'jest',
      `--config=${join(root, 'jest.config.json')}`,
      '--ci',
      '--json',
      `--outputFile=${join(root, '.harness-out', 'jest.json')}`,
      ...(fixture.manifest.run?.argv?.jest ?? []),
    ],
    { cwd: root, env: RECORDER_ENV },
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

/** Each file's path and counters: what the reports are made of, apart from the maps. */
function counters(value: Json | null | undefined): Readonly<Record<string, Json>> {
  return Object.fromEntries(
    Object.entries(filesOf(value)).map(([key, data]) => [
      key,
      { path: data.path ?? null, s: data.s ?? null, f: data.f ?? null, b: data.b ?? null },
    ]),
  )
}

/** Each file's statement, function and branch maps. */
function maps(value: Json | null | undefined): Readonly<Record<string, Json>> {
  return Object.fromEntries(
    Object.entries(filesOf(value)).map(([key, data]) => [
      key,
      {
        statementMap: data.statementMap ?? null,
        fnMap: data.fnMap ?? null,
        branchMap: data.branchMap ?? null,
      },
    ]),
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
    assert.deepEqual(counters(final), counters(expected))
    // `--json`'s `coverageMap` is the same map.
    const results = filesOf(await ran.json('.harness-out/jest.json'))
    const recorded = filesOf(golden?.json?.['.harness-out/jest.json'])
    assert.deepEqual(counters(results.coverageMap), counters(recorded.coverageMap))
  })

  it('the statement, function and branch maps equal the babel provider’s', {
    todo: "B23b Phase 4 gap, Tyler's call: Oxc's TypeScript output is remapped through its source map, which has no segment at most end positions (Istanbul writes `column: null`), and istanbul-lib-source-maps drops each function's and branch's `line`; Jest's babel provider instruments position-true code",
  }, async () => {
    const ran = await provinoOn('coverage/babel-providers-sample')
    const golden = ran.fixture.golden.observed
    assert.deepEqual(
      maps(await ran.json('coverage/coverage-final.json')),
      maps(golden?.json?.['coverage/coverage-final.json']),
    )
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
      counters(await ran.json('coverage/coverage-final.json')),
      counters(golden?.json?.['coverage/coverage-final.json']),
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
