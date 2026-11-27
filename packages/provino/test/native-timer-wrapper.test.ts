// Where a native worker puts its timer wrappers (#230): the wrappers that drain a window file's queued
// work (#227, `orchestrator.windowFileWork`) are on the global only in a worker that runs a window,
// so a node-environment worker's `setTimeout` is Node's own, and a `--detectOpenHandles` report
// points at the project's call, never at Provino. Through the source bin.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, POOLS, spawnCli } from './support.ts'

const JSDOM_CONFIG = "export default { include: ['tests/**/*.test.ts'], environment: 'jsdom' }\n"

/** A test that says whether the four timer globals are `node:timers`' own. */
const TIMERS_ARE_NODES = [
  "import { expect, it } from 'provino'",
  "import * as timers from 'node:timers'",
  "it('has Node\\'s own timers on the global', () => {",
  '  expect({',
  '    setTimeout: setTimeout === timers.setTimeout,',
  '    clearTimeout: clearTimeout === timers.clearTimeout,',
  '    setImmediate: setImmediate === timers.setImmediate,',
  '    clearImmediate: clearImmediate === timers.clearImmediate,',
  '  }).toEqual({ setTimeout: true, clearTimeout: true, setImmediate: true, clearImmediate: true })',
  '})',
  '',
].join('\n')

/** A test whose global `setTimeout` is not `node:timers`' own: the window's wrapper. */
const TIMERS_ARE_WRAPPED = [
  "import { expect, it } from 'provino'",
  "import * as timers from 'node:timers'",
  "it('has the wrapper on the global', () => {",
  '  expect(setTimeout === timers.setTimeout).toBe(false)',
  '  expect(setImmediate === timers.setImmediate).toBe(false)',
  '})',
  '',
].join('\n')

describe('the timer wrappers of a native worker', () => {
  for (const pool of POOLS) {
    test(`are not installed in a node-environment worker, on the ${pool} pool`, async () => {
      const dir = await nativeProject({
        'tests/a.test.ts': TIMERS_ARE_NODES,
        'tests/b.test.ts': TIMERS_ARE_NODES,
      })
      const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      expect({ code: ran.code, outcomes: Object.fromEntries(await outcomesByFile(dir)) }).toEqual({
        code: 0,
        outcomes: { 'a.test.ts': 'passed', 'b.test.ts': 'passed' },
      })
    })
  }

  test('are installed in a jsdom worker before its first file runs', async () => {
    const dir = await nativeProject(
      { 'tests/a.test.ts': TIMERS_ARE_WRAPPED, 'tests/b.test.ts': TIMERS_ARE_WRAPPED },
      JSDOM_CONFIG,
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect({ code: ran.code, outcomes: Object.fromEntries(await outcomesByFile(dir)) }).toEqual({
      code: 0,
      outcomes: { 'a.test.ts': 'passed', 'b.test.ts': 'passed' },
    })
  })

  for (const [environment, config] of [
    ['node', undefined],
    ['jsdom', JSDOM_CONFIG],
  ] as const) {
    test(`leave a --detectOpenHandles report on the project's own call, under ${environment}`, async () => {
      // An interval made from a timeout's callback: the timeout went through the wrapper (under
      // jsdom it is drained as the file ends) and the interval, which is never wrapped, stays open.
      const leak = [
        "import { it } from 'provino'",
        "it('leaks a timer', () => {",
        '  setTimeout(() => { setInterval(() => {}, 60_000) }, 0)',
        '})',
        '',
      ].join('\n')
      const dir = await nativeProject({ 'tests/leak.test.ts': leak }, config)
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
