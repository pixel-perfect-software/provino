// The timers of a file run on a Jest window environment (jest-environment-jsdom through the Jest
// adapter) die with its window, as `window.close()` cancels jsdom's own timers in Jest: work a
// file's last test left pending (a timer set by an effect's cleanup after unmount, a state update
// from a timer, React's scheduler) never runs once the window is gone. Each fixture is held to the
// run Jest 30.5.2 recorded for it, through `provino jest` with one worker.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { assertMatchesGolden, linkEnvironments, provinoOn, WORK } from './recorded-run.ts'

/** Where the projects go: a directory of this file's own under `.work/`, with the environments. */
const PARENT = join(WORK, 'jest-window-timers')

before(() => linkEnvironments(PARENT))
after(async () => {
  await rm(PARENT, { recursive: true, force: true })
})

describe('timers on a Jest window environment, against Jest 30.5.2', () => {
  it('ecosystem/react-work-after-teardown: what the files left pending never runs', async () => {
    const id = 'ecosystem/react-work-after-teardown'
    assertMatchesGolden(id, await provinoOn(id, { parent: PARENT }))
  })

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
