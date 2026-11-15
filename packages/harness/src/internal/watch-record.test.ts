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
  recordWatchSessionExit,
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
  options: {
    startRuns?: number
    /** The exit code `q` ends the session with (default 0). */
    quitCode?: number
    done?: boolean
    onWrite?: (text: string) => void
    /** What `kill()` throws, after it has ended the session (a group left behind). */
    killError?: Error
    /** Raw terminal text printed after the start (a path, say), in place of the usual run. */
    extraOutput?: (cwd: string) => string
  } = {},
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
    output += options.extraOutput?.(cwd) ?? ''
    const session: PtyProcess = {
      write(text) {
        options.onWrite?.(text)
        if (text === 'q') {
          output += '\r\n'
          end({ exitCode: options.quitCode ?? 0, killed: false })
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
        if (options.killError !== undefined) throw options.killError
      },
    }
    return session
  }
  return { spawn, state }
}

/** `spawn`, whose output also holds Jest's "results written" line `shown()` times. */
function printing(
  spawn: NonNullable<WatchRecordOptions['spawn']>,
  shown: () => number,
): NonNullable<WatchRecordOptions['spawn']> {
  return async (...args) => {
    const session = await spawn(...args)
    return {
      ...session,
      output: () => session.output() + 'Test results written to: out.json\r\n'.repeat(shown()),
    }
  }
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

test('a kill that fails after a failed step keeps the step’s error, with the kill’s added', async () => {
  await withWorkDir(async (dir) => {
    const { spawn, state } = fakeSpawn({
      killError: new HarnessError(
        'HARNESS_PTY_LEAK',
        'the terminal child (group 1) still has a process',
      ),
    })
    const watch: FixtureWatch = { ...QUIT, steps: [{ waitText: 'never shown' }], capture: ['runs'] }
    await assert.rejects(recordWatchSession(optionsFor(dir, watch, spawn)), (error: unknown) => {
      assert.ok(error instanceof HarnessError)
      assert.equal(error.code, 'HARNESS_WATCH_FAILED')
      assert.match(error.message, /never shown/)
      assert.match(error.message, /still has a process/)
      return true
    })
    assert.equal(state.kills, 1)
  })
})

test('a kill that fails after the steps passed is the error', async () => {
  await withWorkDir(async (dir) => {
    const { spawn } = fakeSpawn({
      killError: new HarnessError(
        'HARNESS_PTY_LEAK',
        'the pty relay (group 2) still has a process',
      ),
    })
    await assert.rejects(
      recordWatchSession(optionsFor(dir, QUIT, spawn)),
      (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_PTY_LEAK',
    )
  })
})

test('a work directory path that straddles the terminal width is still <root> in the transcript', async () => {
  await withWorkDir(async (dir) => {
    // The path starts near column 110, so a 120-column terminal wraps it in the middle.
    const { spawn } = fakeSpawn({
      extraOutput: (cwd) => `${'x'.repeat(110)} ${cwd}/deep/file.test.ts\r\n`,
    })
    const observed = await recordWatchSession(
      optionsFor(dir, { ...QUIT, keepLines: 'x{10}|file\\.test' }, spawn),
    )
    const transcript = observed.transcript ?? ''
    assert.ok(!transcript.includes(dir.slice(1, 12)), transcript)
    assert.match(transcript.replace(/\n/g, ''), /<root>\/deep\/file\.test\.ts/)
  })
})

test('a run-log line that is still being written is not a run yet, and is not an error', async () => {
  await withWorkDir(async (dir) => {
    const runLog = path.join(dir, 'runs.jsonl')
    const doneLog = path.join(dir, 'done.txt')
    // The reporter has written half of run 1's line; the poll is where it finishes.
    const { spawn } = fakeSpawn({ startRuns: 0 })
    const halfway: NonNullable<WatchRecordOptions['spawn']> = async (argv, cwd, env, deadline) => {
      const session = await spawn(argv, cwd, env, deadline)
      appendFileSync(runLog, '{"files":[],"wasInter')
      return session
    }
    let polls = 0
    const observed = await recordWatchSession({
      ...optionsFor(dir, { ...QUIT, capture: ['runs'] }, halfway),
      poll: async () => {
        polls += 1
        appendFileSync(runLog, 'rupted":false}\n')
        appendFileSync(doneLog, 'done\n')
      },
    })
    assert.equal(polls, 1)
    assert.deepEqual(observed.runs, [{ files: [], wasInterrupted: false }])
  })
})

test('a deadline that kills the session mid-wait is reported as the deadline, not as an end', async () => {
  await withWorkDir(async (dir) => {
    // watch/plugin-typeahead-filename, 2026-11-14: run 2 never came, the deadline killed the
    // session, and the error read "the session ended with 1 of 2 runs".
    let deadline: AbortSignal | undefined
    const { spawn } = fakeSpawn()
    const ending: NonNullable<WatchRecordOptions['spawn']> = async (argv, cwd, env, signal) => {
      const session = await spawn(argv, cwd, env, signal)
      deadline = signal
      // As `spawnInGroup` does: the deadline terminates the group, and the session ends.
      const exit = new Promise<PtyExit>((resolve) => {
        signal.addEventListener('abort', () => resolve({ exitCode: 143, killed: true }), {
          once: true,
        })
      })
      return { ...session, exit }
    }
    const watch: FixtureWatch = { ...QUIT, steps: [{ waitRun: 2 }, { key: 'q' }, { exit: 0 }] }
    await assert.rejects(
      recordWatchSession({
        ...optionsFor(dir, watch, ending),
        timeoutMs: 0,
        // The poll returns once the deadline has passed and the session it killed has ended.
        poll: async () => {
          const signal = deadline
          if (signal !== undefined && !signal.aborted) {
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true }),
            )
          }
          await new Promise((resolve) => setImmediate(resolve))
        },
      }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_WATCH_FAILED' &&
        /the deadline passed with 1 of 2 runs/.test(error.message),
    )
  })
})

test('a session that ended on its own just before the deadline is reported as an end', async () => {
  await withWorkDir(async (dir) => {
    // The mirror of the test above: a Jest crash, then the deadline passes before the poll looks.
    // The end came first (its handler runs before the zero-delay timer), so it is the cause.
    let deadline: AbortSignal | undefined
    const { spawn } = fakeSpawn()
    const crashing: NonNullable<WatchRecordOptions['spawn']> = async (argv, cwd, env, signal) => {
      const session = await spawn(argv, cwd, env, signal)
      deadline = signal
      return { ...session, exit: Promise.resolve({ exitCode: 1, killed: false }) }
    }
    const watch: FixtureWatch = { ...QUIT, steps: [{ waitRun: 2 }, { key: 'q' }, { exit: 0 }] }
    await assert.rejects(
      recordWatchSession({
        ...optionsFor(dir, watch, crashing),
        timeoutMs: 0,
        poll: async () => {
          const signal = deadline
          if (signal !== undefined && !signal.aborted) {
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true }),
            )
          }
          await new Promise((resolve) => setImmediate(resolve))
        },
      }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_WATCH_FAILED' &&
        /the session ended with 1 of 2 runs/.test(error.message),
    )
  })
})

test('a line that lands between the two log reads is judged on a pair the session could have held', async () => {
  await withWorkDir(async (dir) => {
    const runLog = path.join(dir, 'runs.jsonl')
    const doneLog = path.join(dir, 'done.txt')
    const { spawn } = fakeSpawn()
    let reads = 0
    // Run 2 (a real run no step waited for) lands right after the first read of the wait.
    const read = async (file: string): Promise<string | null> => {
      const text = await readFile(file, 'utf8').catch(() => null)
      reads += 1
      if (reads === 1) {
        appendFileSync(runLog, `${JSON.stringify({ files: [], wasInterrupted: false })}\n`)
        appendFileSync(doneLog, 'done\n')
      }
      return text
    }
    await assert.rejects(
      recordWatchSession({ ...optionsFor(dir, QUIT, spawn), read }),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError)
        assert.equal(error.code, 'HARNESS_WATCH_FAILED')
        // Never "1 runs (2 done)": a done line follows its log line, so done is never above seen.
        assert.match(error.message, /holds 2 runs \(1 done\)|holds 2 runs \(2 done\)/)
        assert.match(error.message, /a run no step waited for/)
        return true
      },
    )
  })
})

test('the session exit is returned whether or not the fixture captures exitCode', async () => {
  await withWorkDir(async (dir) => {
    const { spawn } = fakeSpawn({ quitCode: 1 })
    const watch: FixtureWatch = {
      ...QUIT,
      steps: [{ waitRun: 1 }, { key: 'q' }, { exit: 1 }],
      capture: ['runs'],
    }
    const result = await recordWatchSessionExit(optionsFor(dir, watch, spawn))
    assert.equal(result.observed.exitCode, undefined, 'not captured, so not observed')
    assert.equal(result.exitCode, 1)
  })
})

test('captureFile steps are kept per capture, parsed and normalized, under `<path>#<n>`', async () => {
  await withWorkDir(async (dir) => {
    const { spawn: bare } = fakeSpawn()
    const spawn = printing(bare, () => 2)
    const out = path.join(dir, 'out.json')
    const watch: FixtureWatch = {
      argv: ['--watchAll'],
      tty: false,
      timeKeys: ['startTime'],
      steps: [
        { waitRun: 1 },
        { write: { 'out.json': JSON.stringify({ startTime: 5, name: `${dir}/a` }) } },
        { captureFile: 'out.json' },
        { write: { 'out.json': JSON.stringify({ startTime: 9, name: 'b' }) } },
        { captureFile: 'out.json' },
      ],
      capture: ['runs'],
    }
    await writeFile(out, '{}')
    const observed = await recordWatchSession({
      ...optionsFor(dir, watch, spawn),
      normalizeJson: (value) => JSON.parse(JSON.stringify(value).replaceAll(dir, '<root>')),
    })
    assert.deepEqual(observed.json, {
      'out.json#1': { startTime: 5, name: '<root>/a' },
      'out.json#2': { startTime: 9, name: 'b' },
    })
  })
})

test('a captureFile step whose file is not there fails the recording', async () => {
  await withWorkDir(async (dir) => {
    const { spawn: bare } = fakeSpawn()
    const spawn = printing(bare, () => 1)
    const watch: FixtureWatch = {
      argv: ['--watchAll'],
      tty: false,
      steps: [{ waitRun: 1 }, { captureFile: 'nope.json' }],
      capture: ['runs'],
    }
    await assert.rejects(
      recordWatchSession(optionsFor(dir, watch, spawn)),
      (error: unknown) => error instanceof HarnessError && /left no file/.test(error.message),
    )
  })
})

test('a captureFile step waits for Jest to say it wrote the file, once per capture', async () => {
  await withWorkDir(async (dir) => {
    const out = path.join(dir, 'out.json')
    // The run log has its line (waitRun passed) while Jest has written nothing yet: each poll
    // is Jest finishing the next run's file and printing its line.
    let shown = 0
    const { spawn: bare } = fakeSpawn()
    const spawn = printing(bare, () => shown)
    const watch: FixtureWatch = {
      argv: ['--watchAll'],
      tty: false,
      steps: [{ waitRun: 1 }, { captureFile: 'out.json' }, { captureFile: 'out.json' }],
      capture: ['runs'],
    }
    const observed = await recordWatchSession({
      ...optionsFor(dir, watch, spawn),
      poll: async () => {
        shown += 1
        await writeFile(out, JSON.stringify({ run: shown }))
      },
    })
    // Run 1's file is still there when the second capture starts: it must not be read as run 2's.
    assert.deepEqual(observed.json, { 'out.json#1': { run: 1 }, 'out.json#2': { run: 2 } })
  })
})

test('a captureFile step whose session ends before the line fails, with the output tail', async () => {
  await withWorkDir(async (dir) => {
    const { spawn } = fakeSpawn({ quitCode: 0 })
    const watch: FixtureWatch = {
      argv: ['--watchAll'],
      tty: true,
      steps: [{ waitRun: 1 }, { key: 'q' }, { captureFile: 'out.json' }],
      capture: ['runs'],
    }
    await writeFile(path.join(dir, 'out.json'), '{"run":0}')
    await assert.rejects(
      recordWatchSession(optionsFor(dir, watch, spawn)),
      (error: unknown) =>
        error instanceof HarnessError && /before Jest wrote its results file/.test(error.message),
    )
  })
})
