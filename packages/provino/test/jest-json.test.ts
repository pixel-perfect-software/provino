// `provino jest --json --outputFile` (T11.8): the results file as Jest 30.5.2 wrote it for the same
// project (`cli/json-*`: the recorder's `json:` capture, with times as `<time>`, the project's
// path as `<root>` and each run of stack frames as `<frames>`), the line Jest prints about it, the
// exit code, and what a `testResultsProcessor` receives and returns.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'
import type { Reporter } from '@provino/types'
import { type Json, normalizedJson, observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { jestConfigJson, passing, spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

const RESULTS = '.harness-out/jest.json'

interface JsonResults {
  testResults: {
    name: string
    startTime: number
    endTime: number
    message: string
    assertionResults: { failureMessages: string[]; status: string }[]
  }[]
}

/** The run's files in a fixed order (Jest lists them in the order they finished). */
function sorted(value: Json, what: string): Json {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${what}: expected a JSON object, got ${JSON.stringify(value)?.slice(0, 80)}; record the fixture again`,
  )
  const results = value as { testResults?: { name?: unknown }[] }
  if (results.testResults === undefined) return value
  for (const file of results.testResults) {
    assert.equal(typeof file.name, 'string', `${what}: a testResults entry has no string name`)
  }
  return {
    ...(value as object),
    testResults: (results.testResults as { name: string }[]).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  } as Json
}

/** Every number under one of `keys` is finite and not negative (a time or a duration). */
function assertTimes(value: Json, keys: readonly string[], where: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertTimes(item, keys, where)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (keys.includes(key) && typeof inner === 'number') {
        assert.ok(Number.isFinite(inner) && inner >= 0, `${where}: ${key} is ${inner}`)
      }
      assertTimes(inner, keys, `${where}.${key}`)
    }
  }
}

async function provinoOn(id: string): Promise<{
  readonly code: number | null
  readonly stderr: string
  readonly raw: Json
  readonly timeKeys: readonly string[]
  readonly recorded: Json
  readonly recordedStderr: string | undefined
  readonly recordedCode: number | null | undefined
  readonly keys: string | null | undefined
  readonly processorKeys: string | null | undefined
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    await mkdir(join(project.root, '.harness-out'), { recursive: true })
    const argv = fixture.manifest.run?.argv?.jest ?? []
    const ended = await spawnCli(
      [
        'jest',
        `--config=${join(project.root, 'jest.config.json')}`,
        '--ci',
        ...argv,
        '--json',
        `--outputFile=${RESULTS}`,
      ],
      { cwd: project.root },
    )
    const raw = JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json
    const run = fixture.manifest.run
    const normalized = normalizedJson(raw, {
      roots: [project.root],
      timeKeys: run?.timeKeys ?? [],
      mask: run?.mask,
    })
    const golden = fixture.golden.observed
    const processorKeys = golden?.files?.['processor-keys.txt']
    const steps = { roots: [project.root], mask: run?.mask }
    return {
      code: ended.code,
      // The recorder's steps on the same text: roots, the kept lines, the mask.
      stderr: observedText(ended.stderr, { ...steps, keepLines: run?.keepLines ?? '.' }),
      raw,
      timeKeys: run?.timeKeys ?? [],
      recorded: sorted(golden?.json?.[RESULTS] ?? null, `${id}: the golden's ${RESULTS}`),
      recordedStderr: golden?.stderr,
      recordedCode: golden?.exitCode,
      keys: JSON.stringify(sorted(normalized, `${id}: Provino's ${RESULTS}`)),
      processorKeys:
        processorKeys === undefined
          ? undefined
          : observedText(await readFile(join(project.root, 'processor-keys.txt'), 'utf8'), steps),
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest --json writes what Jest 30.5.2 wrote', () => {
  for (const [id, what] of [
    ['cli/json-vscode-contract', 'the contract vscode-jest reads: statuses, locations, snapshot'],
    ['cli/json-no-location', '--testLocationInResults=false: every location is null'],
    ['cli/json-file-states', 'a file that fails to import, an all-skipped file and a focused one'],
    ['cli/json-results-processor', 'a testResultsProcessor: its keys in, its return out'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const run = await provinoOn(id)
      assert.equal(run.code, run.recordedCode, run.stderr)
      assert.equal(run.stderr, run.recordedStderr)
      const files = (run.recorded as unknown as JsonResults).testResults
      assert.ok(files.length > 0, 'the recording has files')
      assert.deepEqual(JSON.parse(run.keys ?? 'null'), run.recorded)
      if (run.processorKeys !== undefined) {
        const golden = (await loadFixture(id)).golden.observed?.files?.['processor-keys.txt']
        assert.equal(run.processorKeys, golden)
      }
      const results = run.raw as unknown as JsonResults
      // The recording masks times, so Provino's own are checked here: real numbers, never negative,
      // and a file does not end before it starts.
      assertTimes(run.raw, run.timeKeys, id)
      for (const file of results.testResults) {
        assert.ok(file.endTime >= file.startTime, `${file.name}: endTime before startTime`)
        if (file.message !== '' && file.message.includes('\n    at ')) {
          assert.match(
            file.message,
            /\.test\.ts:\d+:\d+/,
            'a file-level error names where it happened',
          )
        }
        for (const test of file.assertionResults) {
          assert.ok(['passed', 'failed', 'pending', 'todo'].includes(test.status), test.status)
          for (const message of test.failureMessages) {
            assert.match(message, /\.test\.ts:\d+:\d+/, 'a failure names where it happened')
          }
        }
      }
    })
  }
})

describe('provino jest --json with no output file', () => {
  it('prints the JSON on stdout, even when no test file was found (--passWithNoTests)', async () => {
    const project = await materialize({
      id: 'inline',
      dir: join(import.meta.dirname, 'fixtures'),
      manifest: {
        description: 'no tests',
        config: { jest: { testMatch: ['<rootDir>/none/**/*.test.ts'] } },
      },
      golden: { files: [] },
    })
    try {
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          '--json',
          '--passWithNoTests',
        ],
        { cwd: project.root },
      )
      assert.equal(ended.code, 0, ended.stderr)
      const results = JSON.parse(ended.stdout) as {
        numTotalTests: number
        success: boolean
        testResults: unknown[]
      }
      assert.deepEqual([results.numTotalTests, results.success, results.testResults], [0, true, []])
    } finally {
      await project.dispose()
    }
  })
})

const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: { write(text: string): unknown }
      stderr: Writable
      cwd: string
      reporters?: readonly Reporter[]
      signal?: AbortSignal
    },
  ): Promise<number>
}

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** A project with one passing file, `provino jest` run in this process with `args`. */
async function inProcess(
  args: readonly string[],
  extra: {
    files?: Readonly<Record<string, string>>
    reporters?: readonly Reporter[]
    signal?: AbortSignal
    config?: Readonly<Record<string, unknown>>
  } = {},
): Promise<{ code: number; stdout: string; stderr: string; dir: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-json-exit-')))
  made.push(dir)
  const files = {
    'package.json': '{"type":"commonjs"}\n',
    'jest.config.json': jestConfigJson(dir, extra.config),
    'tests/a.test.js': passing('a'),
    ...extra.files,
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  const stdout = new Sink()
  const stderr = new Sink()
  const code = await runJestCommand(['--ci', ...args], {
    stdout,
    stderr,
    cwd: dir,
    ...(extra.reporters === undefined ? {} : { reporters: extra.reporters }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  })
  return { code, stdout: stdout.text, stderr: stderr.text, dir }
}

describe('provino jest --json when the run does not reach its results', () => {
  it('finding no test exits 1 and writes no JSON, as Jest does before processResults', async () => {
    const ran = await inProcess(['--json', 'no-such-file-matches-this'])
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal(ran.stdout, '')
  })

  it('writes no output file when no test was found', async () => {
    const ran = await inProcess(['--json', '--outputFile=out.json', 'no-such-file-matches-this'])
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal(existsSync(join(ran.dir, 'out.json')), false)
  })

  it('runs no processor when no test was found', async () => {
    const ran = await inProcess(['no-such-file-matches-this'], {
      files: {
        'proc.cjs':
          "require('node:fs').writeFileSync(__dirname + '/ran', '1')\nmodule.exports = (r) => r\n",
      },
      config: { testResultsProcessor: '<rootDir>/proc.cjs' },
    })
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal(existsSync(join(ran.dir, 'ran')), false)
  })

  it('exits 1 when a reporter failed, and the JSON says the run was not a success', async () => {
    const broken: Reporter = {
      name: 'broken',
      'run:end': () => {
        throw new Error('reporter broke')
      },
    }
    const ran = await inProcess(['--json'], { reporters: [broken] })
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal((JSON.parse(ran.stdout) as { success: boolean }).success, false)
  })

  it('writes nothing and keeps the signal exit code when a signal ended the run', async () => {
    const ran = await inProcess(['--json', '--outputFile=out.json'], {
      signal: AbortSignal.abort('SIGINT'),
    })
    assert.equal(ran.code, 130, ran.stderr)
    assert.equal(existsSync(join(ran.dir, 'out.json')), false)
  })

  it('exits 1 with the error, not 2, when the processor throws as it loads', async () => {
    const ran = await inProcess([], {
      files: { 'proc.cjs': "throw new RangeError('processor boom')\n" },
      config: { testResultsProcessor: '<rootDir>/proc.cjs' },
    })
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(ran.stderr, /RangeError: processor boom/)
  })
})
