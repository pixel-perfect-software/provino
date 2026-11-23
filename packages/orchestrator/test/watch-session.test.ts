// T9.11's engine end to end: a watch session over real workers (forks and inline), driven by real
// edits on disk whose events the coordinator feeds the session itself (`fixtures/watch-coordinator.ts`:
// the change source and the coalescing clock are injected, so no file watcher and no wait on time).
// The coordinator is a child in a process group of its own. It checks that no forked worker it noted
// is still running right after `close()` resolves (forks die with their parent, so a check after the
// child exits could miss a leak); the test checks the pids again and sweeps the group.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, it } from 'provino'
import type { Output, SessionSetup, Step } from './fixtures/watch-steps.ts'
import { assertWorkersGone, fixture, takeWorkerPids, trackedProjects } from './support.ts'
import { assertGroupEmpty, killGroup } from './sweep.ts'

const makeProject = trackedProjects(afterAll)

/** A test file that notes, outside the project, which process ran it and what `src/value.js` held. */
function valueTest(name: string, log: string): string {
  return [
    "const { appendFileSync } = require('node:fs')",
    "const { value } = require('./src/value.js')",
    `test(${JSON.stringify(name)}, () => {`,
    `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ file: ${JSON.stringify(name)}, pid: process.pid, value }) + '\\n')`,
    '})',
    '',
  ].join('\n')
}

/** A file outside every project, for a log the test files write. */
async function logFile(name: string): Promise<string> {
  return join((await makeProject({})).dir, name)
}

/** Runs the coordinator child over a project with `steps`, and sweeps its group after. */
async function session(
  kind: 'forks' | 'inline',
  files: Readonly<Record<string, string>>,
  steps: readonly Step[],
  setup: SessionSetup = {},
  dir?: string,
): Promise<Output & { readonly dir: string }> {
  const projectDir = dir ?? (await makeProject(files)).dir
  const out = join(projectDir, '..', `watch-${process.pid}-${kind}-${Date.now()}.json`)
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(fixture('watch-coordinator.ts')), projectDir, kind, out],
    {
      // Its own process group: everything it starts is in it.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        WATCH_STEPS: JSON.stringify(steps),
        WATCH_SETUP: JSON.stringify(setup),
      },
    },
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const pgid = child.pid as number
  const watchdog = setTimeout(() => killGroup(pgid), 60_000)
  let output: Output
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr)
    output = JSON.parse(readFileSync(out, 'utf8')) as Output
    assert.deepEqual(output.aliveAfterClose, [], 'no worker outlived close()')
    assertWorkersGone(await takeWorkerPids(pgid))
    await assertGroupEmpty(pgid, `watch-session (${kind})`)
  } finally {
    clearTimeout(watchdog)
    killGroup(pgid)
    await rm(out, { force: true })
  }
  return { ...output, dir: projectDir }
}

/** The lines the test files appended to `log`. */
function logged(log: string): { file: string; pid: number; value: number }[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { file: string; pid: number; value: number })
}

const VALUE_1 = 'module.exports = { value: 1 }\n'
const VALUE_2 = 'module.exports = { value: 2 }\n'
const HANGS = "test('hangs', () => new Promise((resolve) => setTimeout(resolve, 60_000)))\n"

for (const kind of ['forks', 'inline'] as const) {
  describe(`a watch session over ${kind}`, () => {
    it('runs an edited module’s new code in the same worker', async () => {
      const log = await logFile(`values-${kind}.jsonl`)
      const { reports, batches, dir } = await session(
        kind,
        { 'src/value.js': VALUE_1, 'a.test.js': valueTest('a', log) },
        [
          { do: 'run' },
          { do: 'write', path: 'src/value.js', text: VALUE_2 },
          { do: 'flush' },
          { do: 'run' },
        ],
      )
      assert.deepEqual(batches, [[`change ${join(dir, 'src/value.js')}`]])
      assert.deepEqual(
        reports.map((report) => [report.reason, report.files]),
        [
          ['passed', { 'a.test.js': 'pass' }],
          ['passed', { 'a.test.js': 'pass' }],
        ],
        JSON.stringify(reports.map((report) => report.errors)),
      )
      const [first, second] = reports
      assert.equal(
        second?.workers['a.test.js'],
        first?.workers['a.test.js'],
        'one worker served both runs',
      )
      const lines = logged(log)
      assert.deepEqual(
        lines.map((line) => line.value),
        [1, 2],
        'the second run read the new code',
      )
      assert.equal(lines[0]?.pid, lines[1]?.pid, 'in the same process')
    })

    it('an added file replaces the workers, and the next run finds it', async () => {
      const log = await logFile(`added-${kind}.jsonl`)
      const { reports } = await session(
        kind,
        { 'src/value.js': VALUE_1, 'a.test.js': valueTest('a', log) },
        [
          { do: 'run' },
          { do: 'write', path: 'b.test.js', text: valueTest('b', log) },
          { do: 'flush' },
          { do: 'run' },
        ],
      )
      const [first, second] = reports
      assert.deepEqual(second?.files, { 'a.test.js': 'pass', 'b.test.js': 'pass' })
      assert.notEqual(
        second?.workers['a.test.js'],
        first?.workers['a.test.js'],
        'the worker that ran before the add was retired',
      )
      if (kind === 'forks') {
        const pids = new Set(logged(log).map((line) => line.pid))
        assert.equal(pids.size, 2, 'the second run is a new process')
      }
    })

    it('an unlinked file and a package.json change replace the workers too', async () => {
      const log = await logFile(`unlinked-${kind}.jsonl`)
      const { reports } = await session(
        kind,
        {
          'package.json': '{}\n',
          'src/value.js': VALUE_1,
          'a.test.js': valueTest('a', log),
          'b.test.js': valueTest('b', log),
        },
        [
          { do: 'run' },
          { do: 'unlink', path: 'b.test.js' },
          { do: 'flush' },
          { do: 'run' },
          { do: 'write', path: 'package.json', text: '{ "name": "changed" }\n' },
          { do: 'flush' },
          { do: 'run' },
        ],
      )
      const [first, second, third] = reports
      assert.deepEqual(second?.files, { 'a.test.js': 'pass' }, 'the unlinked file is gone')
      assert.notEqual(second?.workers['a.test.js'], first?.workers['a.test.js'])
      assert.notEqual(third?.workers['a.test.js'], second?.workers['a.test.js'])
    })

    it('a worker at isolation tier none is replaced after any change', async () => {
      const log = await logFile(`none-${kind}.jsonl`)
      const { reports } = await session(
        kind,
        { 'src/value.js': VALUE_1, 'a.test.js': valueTest('a', log) },
        [
          { do: 'run' },
          { do: 'run' },
          { do: 'write', path: 'src/value.js', text: VALUE_2 },
          { do: 'flush' },
          { do: 'run' },
        ],
        { isolation: 'none' },
      )
      const [first, second, third] = reports
      assert.equal(second?.workers['a.test.js'], first?.workers['a.test.js'], 'kept with no change')
      assert.notEqual(
        third?.workers['a.test.js'],
        second?.workers['a.test.js'],
        'replaced after one',
      )
      assert.deepEqual(
        logged(log).map((line) => line.value),
        [1, 1, 2],
      )
    })

    it('runs the global setup and teardown for every run, and new provided values replace the workers', async () => {
      const p = await makeProject({ 'src/value.js': VALUE_1 })
      const log = await logFile(`setup-${kind}.jsonl`)
      const counter = join(p.dir, '..', `round-${kind}-${process.pid}`)
      const setupPath = join(p.dir, '..', `setup-${kind}-${process.pid}.ts`)
      await import('node:fs/promises').then(({ writeFile }) =>
        writeFile(
          setupPath,
          [
            "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
            `const counter = ${JSON.stringify(counter)}`,
            `const log = ${JSON.stringify(log)}`,
            'export default function setup({ provide }: { provide: (key: string, value: unknown) => void }) {',
            "  const round = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1",
            '  writeFileSync(counter, String(round))',
            "  appendFileSync(log, JSON.stringify({ file: 'setup ' + round, pid: 0, value: round }) + '\\n')",
            "  provide('round', round)",
            "  return () => appendFileSync(log, JSON.stringify({ file: 'teardown ' + round, pid: 0, value: round }) + '\\n')",
            '}',
            '',
          ].join('\n'),
        ),
      )
      await import('node:fs/promises').then(({ writeFile }) =>
        writeFile(join(p.dir, 'a.test.js'), valueTest('a', log)),
      )
      const { reports } = await session(
        kind,
        {},
        [{ do: 'run' }, { do: 'run' }],
        { globalSetup: setupPath },
        p.dir,
      )
      assert.deepEqual(
        logged(log).map((line) => line.file),
        ['setup 1', 'a', 'teardown 1', 'setup 2', 'a', 'teardown 2'],
      )
      const [first, second] = reports
      assert.notEqual(
        second?.workers['a.test.js'],
        first?.workers['a.test.js'],
        'a worker booted with round 1 is not given round 2',
      )
    })
  })
}

describe('a watch session over forks', () => {
  // The neutral `orchestrator.watch.interruptedFiles: 'report'`: the killed file is reported failed.
  // (Jest's `drop` is held by `provino`'s `jest-watch.test.ts`, `watch/key-during-run`.)
  it('an interrupt ends the run as interrupted, charges the running file, and the next run is clean', async () => {
    const { reports } = await session(
      'forks',
      { 'hang.test.js': HANGS, 'ok.test.js': "test('ok', () => {})\n" },
      [
        { do: 'run', fileFilters: [{ kind: 'regex', value: 'hang' }], interruptAt: 'hangs' },
        { do: 'run', fileFilters: [{ kind: 'regex', value: 'ok' }] },
      ],
    )
    const [interrupted, clean] = reports
    assert.equal(interrupted?.reason, 'interrupted')
    assert.deepEqual(interrupted?.files, { 'hang.test.js': 'fail' })
    assert.deepEqual(interrupted?.errors['hang.test.js'], [
      'The run was interrupted while hang.test.js was running',
    ])
    assert.equal(clean?.reason, 'passed')
    assert.deepEqual(clean?.files, { 'ok.test.js': 'pass' })
    assert.notEqual(
      clean?.workers['ok.test.js'],
      interrupted?.workers['hang.test.js'],
      'the killed worker was replaced',
    )
  })

  it('close() during a run interrupts it and leaves no worker; closing twice is fine, and nothing runs or listens after', async () => {
    const { reports, heardAfterClose } = await session(
      'forks',
      { 'hang.test.js': HANGS, 'ok.test.js': "test('ok', () => {})\n" },
      [
        { do: 'run', fileFilters: [{ kind: 'regex', value: 'hang' }], closeAt: 'hangs' },
        { do: 'close' },
        { do: 'close' },
        { do: 'run' },
        { do: 'change-after-close', path: 'ok.test.js' },
      ],
    )
    const [closed, after] = reports
    assert.equal(closed?.reason, 'interrupted')
    assert.deepEqual(closed?.files, { 'hang.test.js': 'fail' })
    assert.deepEqual(after?.thrown, {
      code: 'ORCH_BAD_OPTION',
      message: 'The watch session is closed.',
    })
    assert.equal(heardAfterClose, 0)
  })

  it('a listener that throws keeps neither the others nor the session from the batch', async () => {
    const log = await logFile('listener.jsonl')
    const { reports, batches, stderr } = await session(
      'forks',
      { 'src/value.js': VALUE_1, 'a.test.js': valueTest('a', log) },
      [
        { do: 'run' },
        { do: 'write', path: 'src/value.js', text: VALUE_2 },
        { do: 'flush' },
        { do: 'run' },
      ],
      { throwingListener: true },
    )
    assert.equal(batches.length, 1, 'the next listener heard the batch')
    assert.match(stderr, /a listener broke/)
    assert.deepEqual(
      logged(log).map((line) => line.value),
      [1, 2],
      'the workers were still told',
    )
    assert.equal(reports[1]?.reason, 'passed')
  })

  it('a second run while one goes is refused', async () => {
    const { reports } = await session('forks', { 'ok.test.js': "test('ok', () => {})\n" }, [
      { do: 'run', concurrent: true },
    ])
    assert.deepEqual(reports[0]?.concurrent, { code: 'ORCH_BAD_OPTION' })
    assert.equal(reports[0]?.reason, 'passed')
  })

  it('a run that throws ends its killed files before run:end, and the next run hears none of them', async () => {
    const p = await makeProject({})
    const marker = join(p.dir, '..', `started-${process.pid}`)
    const files = {
      'a.test.js': [
        "const { existsSync } = require('node:fs')",
        "test('a', async () => {",
        `  while (!existsSync(${JSON.stringify(marker)})) await new Promise((resolve) => setTimeout(resolve, 5))`,
        '})',
        '',
      ].join('\n'),
      'hang.test.js': [
        "const { writeFileSync } = require('node:fs')",
        "test('hangs', () => {",
        `  writeFileSync(${JSON.stringify(marker)}, '')`,
        '  return new Promise((resolve) => setTimeout(resolve, 60_000))',
        '})',
        '',
      ].join('\n'),
    }
    for (const [name, text] of Object.entries(files)) {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(join(p.dir, name), text))
    }
    const { reports } = await session(
      'forks',
      {},
      [
        { do: 'run', throwOn: 'file:end a.test.js' },
        { do: 'run', fileFilters: [{ kind: 'regex', value: '^a' }] },
      ],
      { maxWorkers: 2 },
      p.dir,
    )
    const [threw, next] = reports
    assert.equal(threw?.thrown?.message, 'the bus broke')
    assert.deepEqual(threw?.events.slice(-1), ['run:end'], JSON.stringify(threw?.events))
    assert.ok(threw?.events.includes('file:end hang.test.js'), 'the killed file ended first')
    assert.deepEqual(next?.events, ['run:start', 'file:end a.test.js', 'run:end'])
  })

  it('a worker from an earlier run that ends badly while it is replaced is not this run’s failure', async () => {
    // Run 1's worker sets an exit code that makes its stop end badly; run 2's global setup provides a
    // new value, so that worker is retired as run 2 begins, and it exits while run 2 goes.
    const p = await makeProject({})
    const log = await logFile('lost.jsonl')
    const counter = join(p.dir, '..', `lost-round-${process.pid}`)
    const setupPath = join(p.dir, '..', `lost-setup-${process.pid}.ts`)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      setupPath,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
        `const counter = ${JSON.stringify(counter)}`,
        'export default function setup({ provide }: { provide: (key: string, value: unknown) => void }) {',
        "  const round = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1",
        '  writeFileSync(counter, String(round))',
        "  provide('round', round)",
        '}',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(p.dir, 'a.test.js'),
      [
        "const { appendFileSync } = require('node:fs')",
        "test('a', () => {",
        "  process.once('exit', () => { process.exitCode = 3 })",
        `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ file: 'a', pid: process.pid, value: 0 }) + '\\n')`,
        '})',
        '',
      ].join('\n'),
    )
    const { reports, stderr } = await session(
      'forks',
      {},
      [{ do: 'run' }, { do: 'run' }],
      { globalSetup: setupPath, unhandledErrors: 'fail-run' },
      p.dir,
    )
    const [, second] = reports
    assert.equal(second?.reason, 'passed', stderr)
    assert.equal(second?.unhandled, 0)
    assert.match(stderr, /exited while it ran no file/)
  })

  it('an affected index that could not be made is made again on its next use', async () => {
    const p = await makeProject({
      'src/value.js': VALUE_1,
      'a.test.js': "require('./src/value.js')\ntest('a', () => {})\n",
    })
    const extractor = join(p.dir, 'extractor.mjs')
    const { reports } = await session(
      'forks',
      {},
      [
        { do: 'run', related: ['src/value.js'] },
        {
          do: 'write',
          path: 'extractor.mjs',
          text: 'export const extractor = () => ({ extract: (code, path, fallback) => fallback(code) })\n',
        },
        { do: 'flush' },
        { do: 'run', related: ['src/value.js'] },
      ],
      { extractor: pathToFileURL(extractor).href },
      p.dir,
    )
    const [failed, retried] = reports
    assert.equal(failed?.reason, 'threw', 'the extractor module is not there yet')
    assert.deepEqual(retried?.files, { 'a.test.js': 'pass' }, JSON.stringify(retried))
  })
})
