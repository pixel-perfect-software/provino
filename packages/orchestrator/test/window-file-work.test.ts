// Which workers put the window-file timer wrappers on the global (#227, #230): only one that runs a
// window file, and before that file's code loads; a worker whose environment has no window keeps
// Node's own timers. Over forks, so the global is the worker's alone.
import { afterAll, describe, expect, it } from 'provino'
import { eventsOf, runJobs, runtimeConfig, runtimeJob, trackedProjects } from './support.ts'

const project = trackedProjects(afterAll)

/** A test that fails unless the global's four timer functions are (or are not) `node:timers`' own. */
function timersAreNodes(expected: boolean): string {
  return [
    "const timers = process.getBuiltinModule('node:timers')",
    `test('timers', () => {`,
    '  const same = [',
    '    setTimeout === timers.setTimeout,',
    '    clearTimeout === timers.clearTimeout,',
    '    setImmediate === timers.setImmediate,',
    '    clearImmediate === timers.clearImmediate,',
    '  ]',
    `  expect(same.join()).toBe('${[expected, expected, expected, expected].join()}')`,
    '})',
  ].join('\n')
}

describe('the window-file timer wrappers', () => {
  it('are never installed in a worker whose environment has no window', async () => {
    const p = await project({
      'a.test.js': timersAreNodes(true),
      'b.test.js': timersAreNodes(true),
    })
    const config = runtimeConfig(p.dir)
    const run = await runJobs({
      pool: 'forks',
      config,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    expect(eventsOf(run.events, 'test-end').map((event) => event.result.state)).toEqual([
      'pass',
      'pass',
    ])
  })

  it('are on the global in a window file, from its first, and stay for the next', async () => {
    const p = await project({
      'a.test.js': timersAreNodes(false),
      'b.test.js': timersAreNodes(false),
    })
    const config = runtimeConfig(p.dir, { environmentOptions: { window: true } })
    const run = await runJobs({
      pool: 'forks',
      config,
      jobs: [runtimeJob(config, p.path('a.test.js')), runtimeJob(config, p.path('b.test.js'))],
    })
    expect(eventsOf(run.events, 'test-end').map((event) => event.result.state)).toEqual([
      'pass',
      'pass',
    ])
  })
})
