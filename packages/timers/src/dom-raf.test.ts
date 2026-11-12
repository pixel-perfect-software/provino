// T4.9's last Done-when clause: with a jsdom window and with a happy-dom `GlobalWindow` as the
// clock's global (the window itself, so nothing real is faked and no environment is needed), the
// fake clock fakes `window.requestAnimationFrame`. `provino`'s `test/env-jsdom.test.ts` runs the
// same thing through the real environment in a worker.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { GlobalWindow } from 'happy-dom'
import { JSDOM } from 'jsdom'
import { createFakeClock } from './clock.ts'
import { neutral } from './internal/test-support.ts'

interface Window {
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(id: number): void
}

const windows: readonly (readonly [string, () => { win: object; close(): void }])[] = [
  [
    'jsdom (pretendToBeVisual)',
    () => {
      const dom = new JSDOM('<!DOCTYPE html>', {
        pretendToBeVisual: true,
      })
      return { win: dom.window, close: () => dom.window.close() }
    },
  ],
  [
    'happy-dom GlobalWindow',
    () => {
      const win = new GlobalWindow()
      return { win, close: () => void win.happyDOM.close() }
    },
  ],
]

for (const [name, make] of windows) {
  describe(name, () => {
    test('window.requestAnimationFrame is faked by the fake clock', () => {
      const { win, close } = make()
      try {
        const dom = win as unknown as { window: Window }
        const real = dom.window.requestAnimationFrame
        assert.equal(typeof real, 'function', 'the window has requestAnimationFrame')

        const clock = createFakeClock(win, neutral)
        clock.install({ now: 0 })
        assert.notEqual(dom.window.requestAnimationFrame, real, 'the window global is faked')

        const times: number[] = []
        dom.window.requestAnimationFrame((time) => times.push(time))
        assert.deepEqual(times, [], 'a faked frame does not run on its own')
        clock.nextFrame()
        assert.equal(times.length, 1, 'advancing a frame runs the callback')
        assert.equal(clock.now(), 16)

        // A frame can be cancelled through the faked global too.
        let ran = false
        const id = dom.window.requestAnimationFrame(() => {
          ran = true
        })
        dom.window.cancelAnimationFrame(id)
        clock.advanceBy(32)
        assert.equal(ran, false)

        clock.uninstall()
        assert.equal(dom.window.requestAnimationFrame, real, 'uninstall puts the real one back')
      } finally {
        close()
      }
    })
  })
}
