// The stand-ins for what jsdom lacks, on a window built straight from `createDom` (so the worker's
// global is never touched). `standIns` is off in the environment itself: the native config turns it on.

import type { DOMWindow } from 'jsdom'
import * as jsdom from 'jsdom'
import { beforeAll, describe, expect, it } from 'provino'
import { jsdomEnvironment } from './environment.ts'
import { installStandIns } from './stand-ins.ts'
import { createDom, type JsdomModule } from './window.ts'

let prepared: JsdomModule
beforeAll(() => {
  prepared = jsdom as unknown as JsdomModule
})

function windowOf(on: boolean, html = '<!DOCTYPE html>'): DOMWindow {
  const win = createDom(prepared, { html }, console).window
  if (on) installStandIns(win)
  return win
}

type Loose = Record<string, unknown>

describe('the stand-ins are on', () => {
  it('gives the window each API jsdom lacks', () => {
    const win = windowOf(true)
    const el = win.document.createElement('div')
    expect(typeof win.matchMedia).toBe('function')
    expect(typeof el.scrollIntoView).toBe('function')
    expect(typeof el.animate).toBe('function')
    expect(typeof (win as unknown as Loose).ResizeObserver).toBe('function')
  })

  it('matchMedia never matches and keeps the query', () => {
    const list = windowOf(true).matchMedia('(min-width: 1px)')
    expect(list.matches).toBe(false)
    expect(list.media).toBe('(min-width: 1px)')
    expect(list.onchange).toBeNull()
    list.addListener(() => {})
    list.removeListener(() => {})
    list.addEventListener('change', () => {})
    expect(list.dispatchEvent(new (windowOf(true).Event)('change'))).toBe(true)
  })

  it('animate returns a finished animation', async () => {
    const el = windowOf(true).document.createElement('div')
    const animation = el.animate([], 1)
    expect(animation.playState).toBe('finished')
    await expect(animation.finished).resolves.toBeDefined()
    await expect(animation.ready).resolves.toBeDefined()
    animation.play()
    animation.pause()
    animation.cancel()
    animation.finish()
    animation.reverse()
  })

  it('a ResizeObserver never calls back', () => {
    const win = windowOf(true)
    const Observer = (win as unknown as Loose).ResizeObserver as new (
      cb: () => void,
    ) => {
      observe(t: unknown): void
      unobserve(t: unknown): void
      disconnect(): void
    }
    let calls = 0
    const observer = new Observer(() => calls++)
    observer.observe(win.document.body)
    observer.unobserve(win.document.body)
    observer.disconnect()
    expect(calls).toBe(0)
  })

  it('a project own value wins, by assignment or defineProperty', () => {
    const win = windowOf(true)
    const own = () => 'own'
    win.matchMedia = own as never
    Object.defineProperty(win.Element.prototype, 'scrollIntoView', { value: own })
    expect(win.matchMedia('x')).toBe('own')
    expect(win.document.createElement('p').scrollIntoView()).toBe('own')
  })

  it('keeps an API the window already has', () => {
    const win = createDom(prepared, {}, console).window
    const own = () => 'jsdom'
    ;(win as unknown as Loose).matchMedia = own
    installStandIns(win)
    expect(win.matchMedia('x')).toBe('jsdom')
  })

  it('gives a connected element one empty box', () => {
    const win = windowOf(true)
    const el = win.document.createElement('div')
    win.document.body.append(el)
    const rects = el.getClientRects()
    expect(rects.length).toBe(1)
    expect(rects.item(0)).toMatchObject({ x: 0, y: 0, width: 0, height: 0 })
    expect([...rects].length).toBe(1)
  })

  it('gives a disconnected element none', () => {
    const win = windowOf(true)
    expect(win.document.createElement('div').getClientRects().length).toBe(0)
  })

  it('gives an element none when it or an ancestor is not displayed', () => {
    const win = windowOf(
      true,
      '<!DOCTYPE html><div id="a" style="display: none"><button id="b"></button></div><button id="c" hidden></button><button id="d"></button>',
    )
    const rects = (id: string) => win.document.getElementById(id)?.getClientRects().length
    expect(rects('a')).toBe(0)
    expect(rects('b')).toBe(0)
    expect(rects('c')).toBe(0)
    expect(rects('d')).toBe(1)
  })
})

describe('the stand-ins are off', () => {
  it('leaves the window as jsdom builds it', () => {
    const win = windowOf(false)
    const el = win.document.createElement('div')
    win.document.body.append(el)
    expect((win as unknown as Loose).matchMedia).toBeUndefined()
    expect((win as unknown as Loose).ResizeObserver).toBeUndefined()
    expect((el as unknown as Loose).scrollIntoView).toBeUndefined()
    expect((el as unknown as Loose).animate).toBeUndefined()
    expect(el.getClientRects().length).toBe(0)
  })
})

describe('the environment', () => {
  it('installs them only with standIns: true, and leaves the global as it found it', async () => {
    const env = await jsdomEnvironment.prepare?.({})
    const names = ['matchMedia', 'ResizeObserver']
    const before = new Set(Reflect.ownKeys(globalThis))
    const read = (): string[] =>
      names.filter((n) => typeof Reflect.get(globalThis, n) !== 'undefined')
    for (const [standIns, expected] of [
      [false, []],
      [true, names],
    ] as const) {
      const instance = jsdomEnvironment.setup(
        {
          options: { standIns },
          realm: 'worker',
          scope: 'file',
          testPath: '/a.test.ts',
          pragmas: {},
          console,
          signal: new AbortController().signal,
        },
        env,
      )
      if (instance instanceof Promise) throw new Error('sets up synchronously')
      expect(read()).toEqual(expected)
      instance.teardown()
      expect(read()).toEqual([])
    }
    expect(new Set(Reflect.ownKeys(globalThis))).toEqual(before)
  })
})
