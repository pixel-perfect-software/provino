import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import type { FixtureWatch } from '../fixture.ts'
import type { PtyExit, PtyProcess } from '../pty.ts'
import { WATCH_DONE_ENV } from '../reporters/jest-watch-done.ts'
import { WATCH_LOG_ENV } from '../reporters/jest-watch-log.ts'
import {
  parseRunLog,
  recordWatchSession,
  WATCH_DONE_PLUGIN_PATH,
  WATCH_LOG_REPORTER_PATH,
  type WatchRecordOptions,
  watchEnv,
  watchJestConfig,
} from './watch-record.ts'

/**
 * A session with no process: on start it logs `startRuns` runs and prints the usage; `q` ends it
 * with 0. `kills` counts `kill()` calls, which the recorder must make whatever happened.
 */
function fakeSpawn(
  options: { startRuns?: number; done?: boolean; onWrite?: (text: string) => void } = {},
) {
  const state = { kills: 0, env: undefined as NodeJS.ProcessEnv | undefined, argv: [] as string[] }
  const spawn: NonNullable<WatchRecordOptions['spawn']> = async (argv, cwd, env) => {
    state.env = env
    state.argv = [...argv]
    const log = env[WATCH_LOG_ENV] ?? ''
    const done = env[WATCH_DONE_ENV] ?? ''
    let output = ''
    let end: (exit: PtyExit) => void = () => {}
    const exit = new Promise<PtyExit>((resolve) => {
      end = resolve
    })
    for (let run = 0; run < (options.startRuns ?? 1); run += 1) {
      appendFileSync(
        log,
        `${JSON.stringify({ files: [{ path: `${cwd}/a.test.ts` }], wasInterrupted: false })}\n`,
      )
      if (options.done !== false) appendFileSync(done, 'done\n')
      output += `\u001b[2J\u001b[3J\u001b[HPASS ${cwd}/a.test.ts\r\nTime:        0.51 s\r\n\r\nWatch Usage\r\n › Press q to quit watch mode.\r\n`
    }
    const session: PtyProcess = {
      write(text) {
        options.onWrite?.(text)
        if (text === 'q') {
          output += '\r\n'
          end({ exitCode: 0, killed: false })
        }
      },
      output: () => output,
      async waitFor(match, from = 0) {
        if (typeof match === 'string' && output.indexOf(match, from) !== -1) return output.length
        throw new HarnessError('HARNESS_WATCH_FAILED', `never showed ${String(match)}`)
      },
      exit,
      childPgid: 1,
      relayPgid: 2,
      async kill() {
        state.kills += 1
        end({ exitCode: null, killed: true })
      },
    }
    return session
  }
  return { spawn, state }
}

async function withWorkDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-record-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function optionsFor(
  dir: string,
  watch: FixtureWatch,
  spawn: NonNullable<WatchRecordOptions['spawn']>,
): WatchRecordOptions {
  return {
    watch,
    argv: ['node', 'jest', '--watchAll'],
    workDir: dir,
    env: { PATH: '/bin', CI: '1', TERM_PROGRAM: 'Apple_Terminal', NO_COLOR: '1' },
    runLog: path.join(dir, 'runs.jsonl'),
    doneLog: path.join(dir, 'done.txt'),
    repo: { dir, ceiling: path.dirname(dir) },
    normalize: (text) => text.replaceAll(dir, '<root>'),
    roots: [dir],
    timeoutMs: 60_000,
    source: 'fixtures/watch/x/fixture.json',
    spawn,
  }
}

const QUIT: FixtureWatch = {
  argv: ['--watchAll'],
  tty: true,
  steps: [{ waitRun: 1 }, { key: 'q' }, { exit: 0 }],
  capture: ['exitCode', 'runs', 'transcript', 'file:out.txt', 'file:missing.txt'],
  keepLines: '^(?:<CLEAR>|PASS|Time:|Watch Usage| › Press)',
}

test('a session is recorded as its exit code, files, runs and kept transcript, then killed', async () => {
  await withWorkDir(async (dir) => {
    await writeFile(path.join(dir, 'out.txt'), `wrote in ${dir}\n`)
    const { spawn, state } = fakeSpawn()
    const observed = await recordWatchSession(optionsFor(dir, QUIT, spawn))
    assert.deepEqual(observed, {
      exitCode: 0,
      files: { 'out.txt': 'wrote in <root>\n', 'missing.txt': null },
      runs: [{ files: [{ path: '<root>/a.test.ts' }], wasInterrupted: false }],
      transcript:
        '<CLEAR>\nPASS <root>/a.test.ts\nTime:        <time>\nWatch Usage\n › Press q to quit watch mode.',
    })
    assert.equal(state.kills, 1, 'the groups are killed after a clean exit too')
    assert.deepEqual(state.argv, ['node', 'jest', '--watchAll'])
    assert.equal(state.env?.[WATCH_LOG_ENV], path.join(dir, 'runs.jsonl'))
  })
})

test('a step that fails still kills the session, and the error is the step’s', async () => {
  await withWorkDir(async (dir) => {
    const { spawn, state } = fakeSpawn()
    const watch: FixtureWatch = { ...QUIT, steps: [{ waitText: 'never shown' }], capture: ['runs'] }
    await assert.rejects(
      recordWatchSession(optionsFor(dir, watch, spawn)),
      (error: unknown) => error instanceof HarnessError && /never shown/.test(error.message),
    )
    assert.equal(state.kills, 1)
  })
})

test('a run no step waited for refuses the recording', async () => {
  await withWorkDir(async (dir) => {
    // Two runs logged where the steps wait for one: during the wait, and after the session.
    const during = fakeSpawn({ startRuns: 2 })
    await assert.rejects(
      recordWatchSession(optionsFor(dir, QUIT, during.spawn)),
      /holds 2 runs \(2 done\) where a step waits for 1/,
    )
    assert.equal(during.state.kills, 1)
    const after = fakeSpawn({
      onWrite: (text) => {
        if (text === 'q') appendFileSync(path.join(dir, 'runs.jsonl'), '{"late":true}\n')
      },
    })
    await assert.rejects(
      recordWatchSession(optionsFor(dir, QUIT, after.spawn)),
      /holds 2 runs, but the steps waited for 1/,
    )
  })
})

test('a keepLines that keeps no line of the transcript is a bad fixture, not an empty golden', async () => {
  await withWorkDir(async (dir) => {
    const { spawn } = fakeSpawn()
    await assert.rejects(
      recordWatchSession(optionsFor(dir, { ...QUIT, keepLines: '^nothing$' }, spawn)),
      (error: unknown) =>
        error instanceof HarnessError && error.code === 'HARNESS_FIXTURE_BAD_WATCH',
    )
  })
})

test('the run log starts empty, whatever a previous session left', async () => {
  await withWorkDir(async (dir) => {
    await writeFile(path.join(dir, 'runs.jsonl'), '{"stale":true}\n')
    const { spawn } = fakeSpawn()
    const observed = await recordWatchSession(
      optionsFor(dir, { ...QUIT, capture: ['runs'] }, spawn),
    )
    assert.equal(observed.runs?.length, 1)
    assert.equal((await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).includes('stale'), false)
  })
})

test('the environment is interactive: not CI, a real terminal type, colour off both ways', () => {
  const env = watchEnv({
    CI: '1',
    NO_COLOR: '1',
    TERM_PROGRAM: 'iTerm.app',
    COLORTERM: 'truecolor',
    PATH: '/bin',
  })
  assert.deepEqual(env, {
    CI: 'false',
    NO_COLOR: '1',
    PATH: '/bin',
    TERM: 'xterm-256color',
    FORCE_COLOR: '0',
  })
})

test('the config adds the run log beside the default reporter, the done plugin last, and keeps the recorder’s files unwatched', () => {
  const logs = { runLog: '/w/.harness-out/runs.jsonl', doneLog: '/w/.harness-out/done.txt' }
  const config = watchJestConfig(
    {
      rootDir: '/w',
      watchPathIgnorePatterns: ['/w/tmp/'],
      watchPlugins: ['jest-watch-typeahead/filename'],
    },
    logs,
  )
  assert.deepEqual(config, {
    rootDir: '/w',
    reporters: ['default', [WATCH_LOG_REPORTER_PATH, { outputFile: logs.runLog }]],
    watchPlugins: [
      'jest-watch-typeahead/filename',
      [WATCH_DONE_PLUGIN_PATH, { outputFile: logs.doneLog }],
    ],
    watchPathIgnorePatterns: ['/w/tmp/', '<rootDir>/.harness-out/', '<rootDir>/.jest-cache/'],
  })
  assert.deepEqual(watchJestConfig({}, logs).watchPlugins, [
    [WATCH_DONE_PLUGIN_PATH, { outputFile: logs.doneLog }],
  ])
  assert.ok(path.isAbsolute(WATCH_LOG_REPORTER_PATH) && path.isAbsolute(WATCH_DONE_PLUGIN_PATH))
})

test('a run is waited for until the done plugin has written it too, not only the reporter', async () => {
  await withWorkDir(async (dir) => {
    // The reporter has logged run 1, but Jest's `onComplete` has not run yet: no done line.
    const doneLog = path.join(dir, 'done.txt')
    let doneWhenQ: string | undefined
    const { spawn, state } = fakeSpawn({
      done: false,
      onWrite: (text) => {
        if (text === 'q') doneWhenQ = readFileSync(doneLog, 'utf8')
      },
    })
    let polls = 0
    const observed = await recordWatchSession({
      ...optionsFor(dir, { ...QUIT, capture: ['runs'] }, spawn),
      // The poll between two reads of the files is where Jest would finish the run.
      poll: async () => {
        polls += 1
        appendFileSync(doneLog, 'done\n')
      },
    })
    assert.equal(polls, 1, 'one more look, after the done line')
    assert.equal(doneWhenQ, 'done\n', 'the q was sent once the run had ended')
    assert.equal(observed.runs?.length, 1)
    assert.equal(state.kills, 1)
  })
})

test('a run log line that is not JSON names its line', () => {
  assert.deepEqual(parseRunLog('{"a":1}\n\n{"b":2}\n', 'x'), [{ a: 1 }, { b: 2 }])
  assert.throws(() => parseRunLog('{"a":1}\nnope\n', 'x'), /line 2 of the run log/)
})
