// T8.2: a jsdom window and a happy-dom `GlobalWindow` are populated onto a fresh vm global; after
// `restore`, the global's own names and every original descriptor are what they were.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { GlobalWindow } from 'happy-dom'
import { JSDOM } from 'jsdom'
import { populateGlobal } from './populate.ts'

type Loose = Record<string | symbol, unknown>

/** A fresh vm global with a few names a DOM populates over, as data, accessors and a symbol. */
function freshGlobal(): Loose {
  const context = createContext({})
  const global = runInContext('globalThis', context) as Loose
  runInContext(
    `
    globalThis.Event = class Event { static original = true }
    globalThis.addEventListener = function original() {}
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw new Error('a native lazy getter must not be read') },
      configurable: true,
      enumerable: false,
    })
    globalThis.global = globalThis
    globalThis[Symbol.for('provino.test')] = 1
    `,
    context,
  )
  return global
}

function snapshot(global: Loose): {
  names: string[]
  symbols: symbol[]
  descriptors: Map<string | symbol, PropertyDescriptor>
} {
  const names = Object.getOwnPropertyNames(global)
  const symbols = Object.getOwnPropertySymbols(global)
  const descriptors = new Map<string | symbol, PropertyDescriptor>()
  for (const key of [...names, ...symbols]) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key)
    if (descriptor !== undefined) descriptors.set(key, descriptor)
  }
  return { names, symbols, descriptors }
}

function windows(): readonly [string, () => { win: object; close: () => void }][] {
  return [
    [
      'jsdom',
      () => {
        const dom = new JSDOM('<!DOCTYPE html><p id="x">hi</p>', { url: 'http://localhost:3000' })
        return { win: dom.window, close: () => dom.window.close() }
      },
    ],
    [
      'happy-dom',
      () => {
        const win = new GlobalWindow({ url: 'http://localhost:3000' })
        win.document.body.innerHTML = '<p id="x">hi</p>'
        return { win, close: () => void win.happyDOM.close() }
      },
    ],
  ]
}

for (const [name, make] of windows()) {
  describe(`a ${name} window`, () => {
    for (const bindFunctions of [false, true]) {
      it(`restores the global exactly (bindFunctions: ${bindFunctions})`, () => {
        const global = freshGlobal()
        const before = snapshot(global)
        const { win, close } = make()
        const populated = populateGlobal(global, win, { bindFunctions })

        // It stands in for the window.
        assert.equal(global.window, global)
        assert.equal(global.self, global)
        assert.equal(global.top, global)
        assert.equal(global.parent, global)
        assert.ok(populated.keys.has('document'))
        const document = global.document as { getElementById(id: string): { textContent: string } }
        assert.equal(document.getElementById('x').textContent, 'hi')
        assert.equal((global.document as { defaultView: unknown }).defaultView, global)
        // The listed key that existed is now the window's, and a write goes through to the window.
        assert.notEqual(global.Event, before.descriptors.get('Event')?.value)
        global.innerWidth = 321
        assert.equal((win as { innerWidth: number }).innerWidth, 321)
        assert.equal(global.innerWidth, 321)

        populated.restore()
        close()
        const after = snapshot(global)
        assert.deepEqual(new Set(after.names), new Set(before.names))
        assert.deepEqual(after.symbols, before.symbols)
        assert.deepStrictEqual(after.descriptors, before.descriptors)
      })
    }

    it('never reads a native lazy getter it replaces or restores', () => {
      const global = freshGlobal()
      const original = Object.getOwnPropertyDescriptor(global, 'localStorage')?.get
      assert.equal(typeof original, 'function')
      const { win, close } = make()
      // The getter throws when called, so a read here fails the test. From Node 26 a read of a vm
      // global's accessor from outside the context no longer calls the getter, so only Node 22
      // and 24 (CI) catch a read; the identity check below holds on every version.
      const populated = populateGlobal(global, win)
      populated.restore()
      close()
      assert.equal(Object.getOwnPropertyDescriptor(global, 'localStorage')?.get, original)
    })
  })
}

it('a key already on the global that is not in the built-in list stays, and is not captured', () => {
  const global = freshGlobal()
  global.mine = 1
  const { win, close } = windows()[0]?.[1]() ?? assert.fail()
  const populated = populateGlobal(global, win)
  assert.equal(global.mine, 1)
  assert.equal(populated.originals.has('mine'), false)
  populated.restore()
  close()
  assert.equal(global.mine, 1)
})
