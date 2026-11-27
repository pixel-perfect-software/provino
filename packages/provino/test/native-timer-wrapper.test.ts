// Where a native worker puts its timer wrappers (#230): the wrappers that drain a window file's queued
// work (#227, `orchestrator.windowFileWork`) are on the global only in a worker that runs a window,
// or in one that shares the coordinator's process, so a node-environment worker's `setTimeout` is
// otherwise Node's own, and a `--detectOpenHandles` report
// points at the project's call, never at Provino. Through the source bin.
import { describe, expect, test } from 'provino'
import { NATIVE_JSDOM_CONFIG, nativeProject, runFiles, spawnCli } from './support.ts'

/** A test that fails unless the four timer globals are (or, under `false`, are not) `node:timers`' own. */
function timersTest(expected: boolean): string {
  return [
    "import { expect, it } from 'provino'",
    "import * as timers from 'node:timers'",
    `it('has ${expected ? "Node\\'s own timers" : 'the wrappers'} on the global', () => {`,
    '  expect({',
    '    setTimeout: setTimeout === timers.setTimeout,',
    '    clearTimeout: clearTimeout === timers.clearTimeout,',
    '    setImmediate: setImmediate === timers.setImmediate,',
    '    clearImmediate: clearImmediate === timers.clearImmediate,',
    `  }).toEqual({ setTimeout: ${expected}, clearTimeout: ${expected}, setImmediate: ${expected}, clearImmediate: ${expected} })`,
    '})',
    '',
  ].join('\n')
}

/**
 * An interval made from a timeout's callback: the timeout went through the wrapper (under jsdom it
 * is drained as the file ends) and the interval, which is never wrapped, stays open.
 */
const LEAK = [
  "import { it } from 'provino'",
  "it('leaks a timer', () => {",
  '  setTimeout(() => { setInterval(() => {}, 60_000) }, 0)',
  '})',
  '',
].join('\n')

describe('the timer wrappers of a native worker', () => {
  // Not `inline`: a worker in the coordinator's process installs them at boot, window or not.
  for (const pool of ['forks', 'threads'] as const) {
    test(`are not installed in a node-environment worker, on the ${pool} pool`, async () => {
      const dir = await nativeProject({
        'tests/a.test.ts': timersTest(true),
        'tests/b.test.ts': timersTest(true),
      })
      expect(await runFiles(dir, pool, ['a', 'b'])).toEqual({
        code: 0,
        outcomes: { a: 'passed', b: 'passed' },
      })
    })
  }

  test("are installed at boot in a node-environment worker that shares the coordinator's process", async () => {
    // `--pool inline` (and a run in band): the workers share one module cache, so a package one
    // loaded keeps what it took from the global for the workers after it, a jsdom project's too.
    const dir = await nativeProject({
      'tests/a.test.ts': timersTest(false),
      'tests/b.test.ts': timersTest(false),
    })
    expect(await runFiles(dir, 'inline', ['a', 'b'])).toEqual({
      code: 0,
      outcomes: { a: 'passed', b: 'passed' },
    })
  })

  test('are installed in a jsdom worker before its first file runs', async () => {
    const dir = await nativeProject(
      { 'tests/a.test.ts': timersTest(false), 'tests/b.test.ts': timersTest(false) },
      NATIVE_JSDOM_CONFIG,
    )
    expect(await runFiles(dir, 'forks', ['a', 'b'])).toEqual({
      code: 0,
      outcomes: { a: 'passed', b: 'passed' },
    })
  })

  for (const [environment, config] of [
    ['node', undefined],
    ['jsdom', NATIVE_JSDOM_CONFIG],
  ] as const) {
    test(`leave a --detectOpenHandles report on the project's own call, under ${environment}`, async () => {
      const dir = await nativeProject({ 'tests/leak.test.ts': LEAK }, config)
      const ran = await spawnCli(
        ['run', '--config', 'provino.config.mjs', '--detectOpenHandles', '--forceExit'],
        { cwd: dir, env: { NO_COLOR: '1' } },
      )
      const lines = ran.stderr.split('\n').map((line) => line.trim())
      const kind = lines.indexOf('●  Timeout')
      expect(kind, ran.stderr).toBeGreaterThan(-1)
      const frames = lines.slice(kind).filter((line) => line.startsWith('at '))
      // The innermost frame is the project's call; none of Provino's frames (its wrapper) is shown.
      expect(frames[0], ran.stderr).toMatch(/tests\/leak\.test\.ts:3:22\)?$/)
      expect(frames.filter((line) => /packages\/|provino\/dist|@provino\//.test(line))).toEqual([])
    })
  }
})
