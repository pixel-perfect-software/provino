// T9.11's engine end to end: a watch session over real workers (forks and inline), driven by real
// edits on disk whose events the coordinator feeds the session itself (`fixtures/watch-coordinator.ts`:
// the change source and the coalescing clock are injected, so no file watcher and no wait on time).
// The coordinator is a child in a process group of its own, so every test checks afterwards that
// `close()` left no worker running (the pids the forked workers noted, and the group's sweep).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { FileFilter } from '@provino/types'
import { assertWorkersGone, fixture, takeWorkerPids, trackedProjects } from './support.ts'
import { assertGroupEmpty, killGroup } from './sweep.ts'

const makeProject = trackedProjects()

interface RunReport {
  readonly reason: string
  readonly files: Record<string, string>
  readonly workers: Record<string, number>
  readonly errors: Record<string, readonly string[]>
}

type Step =
  | {
      readonly do: 'run'
      readonly fileFilters?: readonly FileFilter[]
      readonly interruptAt?: string
    }
  | { readonly do: 'write'; readonly path: string; readonly text: string }
  | { readonly do: 'unlink'; readonly path: string }
  | { readonly do: 'flush' }

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

/** Runs the coordinator child over a project with `steps`, and sweeps its group after. */
async function session(
  kind: 'forks' | 'inline',
  files: Readonly<Record<string, string>>,
  steps: readonly Step[],
): Promise<{
  readonly reports: readonly RunReport[]
  readonly batches: readonly (readonly string[])[]
  readonly dir: string
}> {
  const project = await makeProject(files)
  const out = join(project.dir, '..', `watch-${process.pid}-${kind}-${Date.now()}.json`)
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(fixture('watch-coordinator.ts')), project.dir, kind, out],
    {
      // Its own process group: everything it starts is in it.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, WATCH_STEPS: JSON.stringify(steps) },
    },
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const pgid = child.pid as number
  const watchdog = setTimeout(() => killGroup(pgid), 60_000)
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr)
    // `close()` stopped every worker: none of the pids the forked ones noted is running, and the
    // group holds nothing (the coordinator itself has exited).
    assertWorkersGone(await takeWorkerPids(pgid))
    await assertGroupEmpty(pgid, `watch-session (${kind})`)
  } finally {
    clearTimeout(watchdog)
    killGroup(pgid)
  }
  const result = JSON.parse(readFileSync(out, 'utf8')) as {
    reports: RunReport[]
    batches: string[][]
  }
  await rm(out, { force: true })
  return { ...result, dir: project.dir }
}

/** The lines the test files appended to `log`. */
function logged(log: string): { file: string; pid: number; value: number }[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { file: string; pid: number; value: number })
}

for (const kind of ['forks', 'inline'] as const) {
  describe(`a watch session over ${kind}`, () => {
    it('runs an edited module’s new code in the same worker', async () => {
      const log = join((await makeProject({})).dir, `values-${kind}.jsonl`)
      const { reports, batches, dir } = await session(
        kind,
        {
          'src/value.js': 'module.exports = { value: 1 }\n',
          'a.test.js': valueTest('a', log),
        },
        [
          { do: 'run' },
          { do: 'write', path: 'src/value.js', text: 'module.exports = { value: 2 }\n' },
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
      const log = join((await makeProject({})).dir, `added-${kind}.jsonl`)
      const { reports } = await session(
        kind,
        {
          'src/value.js': 'module.exports = { value: 1 }\n',
          'a.test.js': valueTest('a', log),
        },
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
  })
}

describe('a watch session over forks: an interrupt', () => {
  it('ends the run as interrupted, charges the running file, and the next run is clean', async () => {
    const { reports } = await session(
      'forks',
      {
        'hang.test.js':
          "test('hangs', () => new Promise((resolve) => setTimeout(resolve, 60_000)))\n",
        'ok.test.js': "test('ok', () => {})\n",
      },
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
})
