// Browser APIs jsdom 30 lacks, installed on a window when the `standIns` option is on: no-op
// `scrollIntoView`, `animate` and `ResizeObserver`, a `matchMedia` that never matches, and a
// `getClientRects` that gives a rendered element one empty box. Each is defined only where the window
// has none (a later jsdom that implements one keeps its own), writable and configurable so a
// project's own assignment replaces it. `getClientRects` is the exception: jsdom has one that always
// answers an empty list, so it is replaced. The prototypes belong to the window, which `teardown`
// closes, so nothing outlives the file.
import type { DOMWindow } from 'jsdom'

type Bag = Record<string, unknown>

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}

function lacks(target: object, name: string): boolean {
  return !(name in target)
}

/** The EventTarget members of a stand-in, backed by a real `EventTarget` of the window. */
function eventTarget(win: DOMWindow): Bag {
  const target = new win.EventTarget()
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  }
}

function matchMedia(win: DOMWindow): (query: string) => object {
  return (query) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addListener() {},
    removeListener() {},
    ...eventTarget(win),
  })
}

function animate(win: DOMWindow): () => object {
  return () => {
    const done = Promise.resolve()
    const animation: Bag = {
      finished: done,
      ready: done,
      playState: 'finished',
      pending: false,
      id: '',
      currentTime: 0,
      startTime: null,
      playbackRate: 1,
      onfinish: null,
      oncancel: null,
      onremove: null,
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      reverse() {},
      commitStyles() {},
      persist() {},
      updatePlaybackRate() {},
      ...eventTarget(win),
    }
    // The promises resolve with the animation itself, as a browser's do.
    animation.finished = done.then(() => animation)
    animation.ready = done.then(() => animation)
    return animation
  }
}

class StandInResizeObserver {
  constructor(_callback?: unknown) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** One empty box at the origin, from the window's `DOMRect` when it has one. */
function emptyRect(win: DOMWindow): object {
  const Rect = (win as unknown as Bag).DOMRect
  if (typeof Rect === 'function') return new (Rect as new (...a: number[]) => object)(0, 0, 0, 0)
  return Object.freeze({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
    },
  })
}

function rectList(rects: readonly object[]): object {
  return Object.assign([...rects], { item: (index: number) => rects[index] ?? null })
}

/** Whether an element and every ancestor (through shadow roots) has a computed `display` other than `none`. */
function rendered(win: DOMWindow, element: Element): boolean {
  if (!element.isConnected) return false
  let node: Node | null = element
  while (node !== null) {
    if (node.nodeType === 1 && win.getComputedStyle(node as Element).display === 'none')
      return false
    node = node.parentNode ?? (node as unknown as { host?: Node }).host ?? null
  }
  return true
}

/** Installs the stand-ins on `win`. */
export function installStandIns(win: DOMWindow): void {
  const proto = win.Element.prototype
  if (lacks(win, 'matchMedia')) define(win, 'matchMedia', matchMedia(win))
  if (lacks(win, 'ResizeObserver')) define(win, 'ResizeObserver', StandInResizeObserver)
  if (lacks(proto, 'scrollIntoView')) define(proto, 'scrollIntoView', function scrollIntoView() {})
  if (lacks(proto, 'animate')) define(proto, 'animate', animate(win))
  // One rect per rendered element: a focus trap that counts the controls with a box needs it.
  const rect = emptyRect(win)
  define(proto, 'getClientRects', function getClientRects(this: Element) {
    return rendered(win, this) ? rectList([rect]) : rectList([])
  })
}
