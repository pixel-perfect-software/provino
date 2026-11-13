// T9.10 through the bin: the exit codes (0, 1, 2, 130, 143), a second Ctrl+C, `--bail`,
// `--detectOpenHandles` and `--forceExit`, with `--bail`, the open-handle report and the force-exit
// line held to Jest 30.5.2 (the recorded `cli/*` fixtures, and for the open handles also a live
// Jest run on the same tree). The bin is a child process in a process group of its own, with a
// deadline, and after every run nothing of that group may be left (`sweep`: `ps` where it runs,
// and a `kill(-pgid, 0)` probe that needs no `ps`).
//
// `provino jest` keeps Jest's exit codes: `jest-exit-codes.test.ts` holds the seven cases against
// their goldens (7/7), and the usage-error case below puts Jest's 1 beside `provino run`'s 2 (D76).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runJest } from './live-jest.ts'
import { loadFixture, materialize, type RecordedFixture, underRoot } from './recorded.ts'
import {
  failing,
  isRunning,
  type LiveCli,
  notedPids,
  passing,
  spawnCli,
  startCli,
  trackedProjects,
} from './support.ts'
import { assertGroupEmpty, killGroup } from './sweep.ts'

const makeProject = trackedProjects()

/** The bin in a process group of its own, so a sweep can tell what it left behind. */
function startGroup(
  args: readonly string[],
  cwd: string,
  deadlineMs = 60_000,
  nodeArgs: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): LiveCli {
  return startCli(args, { cwd, deadlineMs, nodeArgs, env, detached: true })
}

/** A preload that swaps the bin's `main` for one that never settles (`fixtures/unsettled-main/`). */
const UNSETTLED_MAIN_PRELOAD: string = fileURLToPath(
  new URL('./fixtures/unsettled-main/preload.ts', import.meta.url),
)

/** Waits until the process has written `text` to its stdout. */
async function untilOutput(live: LiveCli, text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!live.stdout().includes(text)) {
    if (Date.now() > deadline) assert.fail(`no "${text}" in time:\n${live.stderr()}`)
    await sleep(25)
  }
}

/** Waits until the process has written `text` to its stderr. */
async function untilStderr(live: LiveCli, text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!live.stderr().includes(text)) {
    if (Date.now() > deadline) assert.fail(`no "${text}" on stderr in time:\n${live.stderr()}`)
    await sleep(25)
  }
}

/** Waits until `pidFile` holds `count` pids, and returns them. */
async function untilNoted(pidFile: string, count = 1, timeoutMs = 30_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = [...(await notedPids(pidFile))]
    if (pids.length >= count) return pids
    if (Date.now() > deadline) throw new Error(`no ${count} pids noted in ${pidFile} in time`)
    await sleep(25)
  }
}

/**
 * A test file that notes its worker's pid and then loops without yielding, for 120 s: past every
 * test's deadline, and bounded so a worker that a killed test run leaves behind ends by itself.
 */
const hanging = (pidFile: string): string =>
  [
    "const { appendFileSync } = require('node:fs')",
    "test('hangs', () => {",
    `  appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n')`,
    '  const end = Date.now() + 120_000; while (Date.now() < end) {}',
    '})',
    '',
  ].join('\n')

/** Nothing of the group is left, and no noted worker is running. */
async function assertNoChild(live: LiveCli, pids: readonly number[]): Promise<void> {
  for (const pid of pids) assert.equal(isRunning(pid), false, `worker ${pid} is still running`)
  await assertGroupEmpty(live.pgid, 'lifecycle')
}

describe('exit codes through the bin (provino run)', () => {
  it('0 for a pass, and 1 for a failing test', async () => {
    const passed = await makeProject({ 'tests/a.test.js': passing('a') })
    const failed = await makeProject({ 'tests/a.test.js': failing('a') })
    assert.equal((await spawnCli(['run', '--config', passed.config], { cwd: passed.dir })).code, 0)
    assert.equal((await spawnCli(['run', '--config', failed.config], { cwd: failed.dir })).code, 1)
  })

  it('2 for a usage error under provino run, where provino jest gives Jest’s 1 (D76)', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const noConfig = await spawnCli(['run'], { cwd: project.dir })
    const badFlag = await spawnCli(['run', '--config', project.config, '--bogus'], {
      cwd: project.dir,
    })
    assert.equal(noConfig.code, 2, noConfig.stderr)
    assert.equal(badFlag.code, 2, badFlag.stderr)
    const jest = await spawnCli(['jest', '--bogus-flag'], { cwd: project.dir })
    assert.equal(jest.code, 1, jest.stderr)
  })

  // SIGHUP is handled like SIGTERM: Node's default action would end the bin at once and leave a
  // worker that is in a synchronous loop running.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    it(`${code} for ${signal} while two workers are in a synchronous busy loop: both are killed and nothing is left`, async () => {
      const project = await makeProject((dir) => ({
        'tests/hang.test.js': hanging(join(dir, 'workers.pids')),
        'tests/hang2.test.js': hanging(join(dir, 'workers.pids')),
      }))
      const pidFile = project.path('workers.pids')
      const live = startGroup(['run', '--config', project.config, '--maxWorkers', '2'], project.dir)
      try {
        const pids = await untilNoted(pidFile, 2)
        // To the bin alone, not its group: it has to clean up its workers itself.
        live.child.kill(signal)
        const ended = await live.exited
        assert.deepEqual(ended, { code, signal: null }, live.stderr())
        assert.match(live.stderr(), /Interrupted/)
        await assertNoChild(live, pids)
      } finally {
        killGroup(live.pgid)
      }
    })
  }

  // The second signal is the force. The bin's `main` is a stand-in that stays up until the force
  // signal, so the first signal can't end the run before the second lands. With real workers in a
  // busy loop it can: the first signal already kills them (B21 Choice 3), the run ends at once, and
  // a second signal that lands in Node's own exit teardown takes the default action, which a test
  // can't tell from a bug. The kill of a worker stuck in its stop by the force is the orchestrator's
  // `lifecycle.test.ts` (`stuck-stop-worker.ts`).
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const) {
    it(`a second ${signal} is the force: the bin, slow to stop, is gone within 1 s, with ${code}`, async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const live = startGroup(
        ['run', '--config', project.config],
        project.dir,
        60_000,
        ['--import', UNSETTLED_MAIN_PRELOAD],
        { UNSETTLED_MAIN_HOLD: 'force' },
      )
      try {
        await untilOutput(live, 'ready')
        live.child.kill(signal)
        await untilOutput(live, 'cancelled')
        const alive = await Promise.race([
          live.exited.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
        ])
        assert.equal(alive, true, `one ${signal} does not end a run that is slow to stop`)
        const second = Date.now()
        live.child.kill(signal)
        const ended = await live.exited
        assert.deepEqual(ended, { code, signal: null }, live.stderr())
        assert.ok(Date.now() - second < 1000, 'the bin ended within the grace')
      } finally {
        killGroup(live.pgid)
      }
    })
  }

  it('130 for SIGINT when the run is left with nothing to hold the event loop open, not Node’s 13 for an unsettled await', async () => {
    // The bin's `main` is replaced (a resolve hook) by one that says "ready" and never settles, with
    // no handle: what a reporter promise that never settles looks like once the workers are gone.
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const live = startGroup(['run', '--config', project.config], project.dir, 60_000, [
        '--import',
        UNSETTLED_MAIN_PRELOAD,
      ])
      try {
        await untilOutput(live, 'ready')
        live.child.kill(signal)
        const ended = await live.exited
        assert.deepEqual(ended, { code, signal: null }, `${signal}: ${live.stderr()}`)
      } finally {
        killGroup(live.pgid)
      }
    }
  })
})

/** A recorded Jest fixture as a project, run through `provino jest`. */
async function runFixture(
  id: string,
  extra: readonly string[] = [],
): Promise<{
  readonly fixture: RecordedFixture
  readonly root: string
  readonly code: number | null
  readonly stderr: string
  dispose(): Promise<void>
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  const args = fixture.manifest.run?.argv?.jest ?? []
  const ended = await spawnCli(
    ['jest', `--config=${join(project.root, 'jest.config.json')}`, ...args, ...extra],
    { cwd: project.root },
  )
  assert.equal(ended.signal, null, 'it exited, it was not killed')
  return {
    fixture,
    root: project.root,
    code: ended.code,
    stderr: underRoot(ended.stderr, project.root),
    dispose: project.dispose,
  }
}

/** The `PASS`/`FAIL` file lines a golden's stderr kept, as `[state, path]` with the path as Jest prints it (`./a.test.ts`). */
function goldenFileLines(stderr: string): [string, string][] {
  return stderr.split('\n').flatMap((line) => {
    const match = /^(PASS|FAIL) (\S+)/.exec(line)
    return match === null ? [] : [[match[1] as string, match[2] as string]]
  })
}

describe('--bail against Jest 30.5.2', () => {
  for (const [id, name] of [
    ['cli/bail-one', '--bail ends the run after the first file that fails'],
    ['cli/bail-two', 'the config’s bail: 2 counts failed tests across files'],
  ] as const) {
    it(`${name} (${id})`, async () => {
      const run = await runFixture(id)
      try {
        const golden = run.fixture.golden.observed
        assert.equal(run.code, golden?.exitCode, run.stderr)
        const expected = golden?.stderr ?? ''
        // The files Jest reported are the files we report, and no other: the rest never started.
        const files = goldenFileLines(expected)
        assert.ok(files.length >= 1, 'the golden kept the file lines')
        for (const [state, path] of files) {
          assert.match(run.stderr, new RegExp(`^${state} ${path.replace('.', '\\.')}`, 'm'))
        }
        const all = ['a-fails.test.ts', 'b-passes.test.ts', 'b-fails.test.ts', 'c-passes.test.ts']
        const reported = new Set(files.map(([, path]) => path.replace(/^\.\//, '')))
        for (const path of all.filter((name) => !reported.has(name))) {
          assert.doesNotMatch(run.stderr, new RegExp(path.replace('.', '\\.')))
        }
        // The summary, line for line: the suites "1 of 3 total" included.
        for (const line of expected.split('\n').filter((l) => /^(Test Suites|Tests):/.test(l))) {
          assert.ok(run.stderr.split('\n').includes(line), `stderr has "${line}":\n${run.stderr}`)
        }
      } finally {
        await run.dispose()
      }
    })
  }

  it('a file that fails to load is not a failed test: it does not count, and the later files run (cli/bail-on-load-error)', async () => {
    const run = await runFixture('cli/bail-on-load-error')
    try {
      const golden = run.fixture.golden.observed
      assert.equal(run.code, golden?.exitCode, run.stderr)
      const expected = golden?.stderr ?? ''
      const files = goldenFileLines(expected)
      assert.deepEqual(
        files.map(([state, path]) => `${state} ${path}`),
        ['FAIL ./a-throws.test.ts', 'PASS ./b-passes.test.ts', 'PASS ./c-passes.test.ts'],
        'Jest ran all three: the load failure is not a failed test',
      )
      for (const [state, path] of files) {
        assert.match(run.stderr, new RegExp(`^${state} ${path.replace('.', '\\.')}`, 'm'))
      }
      for (const line of expected.split('\n').filter((l) => /^(Test Suites|Tests):/.test(l))) {
        assert.ok(run.stderr.split('\n').includes(line), `stderr has "${line}":\n${run.stderr}`)
      }
    } finally {
      await run.dispose()
    }
  })

  it('without a bail the same project runs every file (the control)', async () => {
    const fixture = await loadFixture('cli/bail-one')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(['jest', `--config=${join(project.root, 'jest.config.json')}`], {
        cwd: project.root,
      })
      assert.equal(ended.code, 1)
      assert.match(ended.stderr, /Test Suites: 1 failed, 2 passed, 3 total/)
    } finally {
      await project.dispose()
    }
  })

  it('--bail=2 is false in Jest 30.5.2 (a boolean flag), and so it is here: nothing bails', async () => {
    const fixture = await loadFixture('cli/bail-one')
    const project = await materialize(fixture)
    try {
      const args = [`--config=${join(project.root, 'jest.config.json')}`, '--bail=2', '--ci']
      const provino = await spawnCli(['jest', ...args], { cwd: project.root })
      const jest = (await runJest(project.root, ['--watchman=false', ...args])).stderr
      const summary = (text: string): string[] =>
        text.split('\n').filter((line) => /^(Test Suites|Tests):/.test(line))
      assert.deepEqual(summary(provino.stderr), summary(jest))
      assert.match(provino.stderr, /Test Suites: 1 failed, 2 passed, 3 total/)
    } finally {
      await project.dispose()
    }
  })
})

describe('a skipped file against Jest 30.5.2', () => {
  for (const [id, name] of [
    ['cli/skipped-file', 'a skipped file is not a suite that ran: 1 of 2 total'],
    [
      'cli/skipped-file-alone',
      'a project whose only file is skipped has run no suite: 0 of 1 total',
    ],
  ] as const) {
    it(`${name} (${id})`, async () => {
      const run = await runFixture(id)
      try {
        const golden = run.fixture.golden.observed
        assert.equal(run.code, golden?.exitCode, run.stderr)
        const expected = golden?.stderr ?? ''
        // The summary, line for line: the suites line is the one that is easy to get wrong.
        const summary = expected.split('\n').filter((l) => /^(Test Suites|Tests):/.test(l))
        assert.equal(summary.length, 2)
        for (const line of summary) {
          assert.ok(run.stderr.split('\n').includes(line), `stderr has "${line}":\n${run.stderr}`)
        }
        for (const [state, path] of goldenFileLines(expected)) {
          assert.match(run.stderr, new RegExp(`^${state} ${path.replace('.', '\\.')}`, 'm'))
        }
        // Jest prints no line for a suite whose every test is skipped, and neither do we (DV50).
        assert.deepEqual(
          run.stderr.split('\n').filter((line) => /^(PASS|FAIL|SKIP) /.test(line)),
          expected.split('\n').filter((line) => /^(PASS|FAIL|SKIP) /.test(line)),
          'the same file lines as Jest: none for the skipped file',
        )
      } finally {
        await run.dispose()
      }
    })
  }
})

/** Everything from the open-handle header on, with Jest's frame function names (`Object.setInterval`) made one. */
function handlesBlock(stderr: string): string {
  const from = stderr.indexOf('Jest has detected the following')
  assert.notEqual(from, -1, `no open-handle report in:\n${stderr}`)
  return stderr
    .slice(from)
    .replace(/at Object\.\S+ \(/g, 'at <fn> (')
    .trimEnd()
}

describe('--detectOpenHandles against Jest 30.5.2', () => {
  it('prints the kind and the creating stack of a leaked setInterval (cli/detect-open-handles)', async () => {
    const run = await runFixture('cli/detect-open-handles')
    try {
      assert.equal(run.code, run.fixture.golden.observed?.exitCode, run.stderr)
      const lines = run.stderr.split('\n')
      // The golden kept the header, the kind and the first frame, normalized: `at <root>/leak.test.ts:3:3`.
      const expected = (run.fixture.golden.observed?.stderr ?? '').split('\n')
      assert.equal(expected.length, 3)
      for (const line of expected.slice(0, 2)) {
        assert.ok(lines.includes(line), `stderr has "${line}":\n${run.stderr}`)
      }
      // The line is Jest's. The column of a TypeScript file is the transformed code's (a tab for
      // the two spaces of indent: 3:2 for Jest's 3:3), since nothing maps a stack through the
      // transform's source map yet; the `.js` project below holds the column too.
      const frame = /at <root>\/(\S+):(\d+):\d+$/.exec(expected[2] ?? '')
      assert.ok(frame, `the golden's frame: ${expected[2]}`)
      const file = (frame[1] ?? '').replace('.', '\\.')
      assert.match(run.stderr, new RegExp(`\\(${file}:${frame[2]}:\\d+\\)`))
    } finally {
      await run.dispose()
    }
  })

  it('prints it as live Jest does: the same block, column included, whatever the frame function’s name', async () => {
    const project = await makeProject({
      'tests/leak.test.js': [
        "test('leaks', () => {",
        '  setInterval(() => {}, 1000)',
        '  setTimeout(() => {}, 60000)',
        '})',
        '',
      ].join('\n'),
    })
    const args = ['--detectOpenHandles', '--forceExit', '--ci', '--watchman=false']
    // Both under `NO_COLOR`: with `CI` set (GitHub's runners) live Jest highlights the code frame.
    const provino = await spawnCli(['jest', ...args], { cwd: project.dir, env: { NO_COLOR: '1' } })
    const jest = (await runJest(project.dir, args)).stderr
    assert.equal(handlesBlock(provino.stderr), handlesBlock(jest))
    assert.match(provino.stderr, /following 2 open handles/, 'two handles, as Jest counts them')
  })

  it('reports nothing for a project that cleans up', async () => {
    const project = await makeProject({
      'tests/a.test.js': [
        "test('cleans up', () => {",
        '  const timer = setInterval(() => {}, 1000)',
        '  clearInterval(timer)',
        '})',
        '',
      ].join('\n'),
    })
    const ended = await spawnCli(['run', '--config', project.config, '--detectOpenHandles'], {
      cwd: project.dir,
    })
    assert.equal(ended.code, 0, ended.stderr)
    assert.doesNotMatch(ended.stderr, /open handle/)
  })
})

describe('--forceExit against Jest 30.5.2', () => {
  it('says it is force exiting, as Jest does, and exits with the run’s code (cli/force-exit)', async () => {
    const run = await runFixture('cli/force-exit')
    try {
      assert.equal(run.code, run.fixture.golden.observed?.exitCode, run.stderr)
      for (const line of (run.fixture.golden.observed?.stderr ?? '').split('\n')) {
        assert.ok(run.stderr.split('\n').includes(line), `stderr has "${line}":\n${run.stderr}`)
      }
    } finally {
      await run.dispose()
    }
  })

  it('ends a run that a leaked handle would keep alive; without it the process stays up', async () => {
    const leaking = ["test('leaks', () => {", '  setInterval(() => {}, 1000)', '})', ''].join('\n')
    const project = await makeProject({ 'tests/leak.test.js': leaking })
    // In band, the leak is in the bin's own process: only --forceExit lets it end.
    const forced = await spawnCli(
      ['run', '--config', project.config, '--pool', 'inline', '--forceExit'],
      { cwd: project.dir, deadlineMs: 30_000 },
    )
    assert.equal(forced.signal, null)
    assert.equal(forced.code, 0, forced.stderr)
    assert.match(forced.stderr, /Test Suites: 1 passed, 1 total/)
    assert.match(forced.stderr, /force exiting/i)

    const held = startGroup(['run', '--config', project.config, '--pool', 'inline'], project.dir)
    try {
      // The run is over once its summary is out; a process with nothing holding it open ends then.
      await untilStderr(held, 'Test Suites: 1 passed, 1 total')
      const ended = await Promise.race([held.exited.then(() => true), sleep(500).then(() => false)])
      assert.equal(ended, false, 'without --forceExit the interval holds the process up')
    } finally {
      killGroup(held.pgid)
      await held.exited
    }
  })
})
