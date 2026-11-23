// The timers of a file run on a Jest window environment (jest-environment-jsdom through the Jest
// adapter) die with its window, as `window.close()` cancels jsdom's own timers in Jest: work a
// file's last test left pending (a timer set by an effect's cleanup after unmount, a state update
// from a timer, React's scheduler, a hook a shared package registered) never runs once the window
// is gone, and with no `fetch` in the window no reply comes after it either. Each fixture is held
// to the run Jest 30.5.2 recorded for it, through `provino jest` with one worker.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'provino'
import { assertMatchesGolden, linkEnvironments, provinoOn, WORK } from './recorded-run.ts'

/** Where the projects go: a directory of this file's own under `.work/`, with the environments. */
const PARENT = join(WORK, 'jest-window-timers')

beforeAll(() => linkEnvironments(PARENT))
afterAll(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('timers on a Jest window environment, against Jest 30.5.2', () => {
  it('ecosystem/react-work-after-teardown: what the files left pending never runs', async () => {
    const id = 'ecosystem/react-work-after-teardown'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('ecosystem/react-scheduler-loop: a slice the scheduler schedules from its own callback dies with the window', async () => {
    const id = 'ecosystem/react-scheduler-loop'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('env/jsdom-shared-timer-flag: the next file gets its own copy of a package whose timer the window cancelled', async () => {
    const id = 'env/jsdom-shared-timer-flag'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it("env/jsdom-shared-timer-flag-nested: a package whose timer the test's own timer's callback set goes per file too", async () => {
    const id = 'env/jsdom-shared-timer-flag-nested'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('env/jsdom-timer-captured-early: a package a node file loaded first still sets noted timers', async () => {
    const id = 'env/jsdom-timer-captured-early'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it("env/jsdom-shared-hook-timer: a timer set from a shared package's own afterEach dies with the window", async () => {
    const id = 'env/jsdom-shared-hook-timer'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  it('env/jsdom-no-fetch: a window file has no fetch, so a package that looks for one as it loads finds none', async () => {
    const id = 'env/jsdom-no-fetch'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

  // In band the files run in the bin's own process, whose global timers the coordinator uses too:
  // only what a file's own code set dies with its window.
  for (const id of [
    'ecosystem/react-work-after-teardown',
    'ecosystem/react-scheduler-loop',
    'env/jsdom-shared-timer-flag',
    'env/jsdom-shared-timer-flag-nested',
    'env/jsdom-shared-hook-timer',
    'env/jsdom-no-fetch',
  ]) {
    it(`${id}, in band (-i): the same outcome as with one worker`, async () => {
      assertMatchesGolden(id, await provinoOn(id, { parent: PARENT, argv: ['-i'] }))
    })
  }

  it("env/jsdom-timer-globals: the timers a test sees, Node's where the window has none", async () => {
    const id = 'env/jsdom-timer-globals'
    const titles = (capture: unknown): unknown =>
      (capture as { testResults: { assertionResults: { title: string }[] }[] }).testResults.flatMap(
        (file) => file.assertionResults.map((test) => test.title),
      )
    const same = [
      'typeof queueMicrotask is function',
      "setTimeout is the window's: true",
      "setInterval is the window's: true",
      "clearTimeout is the window's: true",
    ]
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }), {
      declared: {
        'json:.harness-out/jest.json': {
          golden: [
            'typeof setImmediate is undefined',
            'typeof clearImmediate is undefined',
            'typeof MessageChannel is undefined',
            ...same,
            'setTimeout returns a number',
          ],
          provino: [
            'typeof setImmediate is function',
            'typeof clearImmediate is function',
            'typeof MessageChannel is function',
            ...same,
            'setTimeout returns a object',
          ],
          reason:
            "the window is populated onto the worker's global, whose Node timers stay where the window has none (no setImmediate or MessageChannel) and whose setTimeout returns Node's Timeout; hiding them per file would make them per-file globals a shared package reads as it loads (D129)",
          view: titles,
        },
      },
    })
  })
})
