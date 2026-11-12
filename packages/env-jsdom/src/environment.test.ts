// T8.3 (jsdom): a fresh window per file on the worker's own global, fully restored. These tests
// change the real `globalThis`, so each runs synchronously and inside `guarded`, which puts back
// the keys the test touched whether or not `teardown` worked.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import type { EnvironmentInstance, EnvironmentSetupContext } from '@provino/types'
import { type JsdomEnvironmentOptions, jsdomEnvironment } from './index.ts'

type Key = string | symbol

function context(
  options: JsdomEnvironmentOptions = {},
  realm: 'worker' | 'context' = 'worker',
): EnvironmentSetupContext<JsdomEnvironmentOptions> {
  return {
    options,
    realm,
    scope: 'file',
    testPath: '/a.test.ts',
    pragmas: {},
    console,
    signal: new AbortController().signal,
  }
}

function properties(): ReadonlyMap<Key, PropertyDescriptor> {
  const all = new Map<Key, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key)
    if (descriptor !== undefined) all.set(key, descriptor)
  }
  return all
}
// Reading every descriptor once loads Node's lazy globals, so no test sees them appear.
properties()

const prepared: unknown = await jsdomEnvironment.prepare?.({})

/** Runs `body`, then puts every key the global has now or had before back as it was. */
function guarded(body: () => void): void {
  const before = properties()
  try {
    body()
  } finally {
    for (const key of Reflect.ownKeys(globalThis)) {
      if (!before.has(key)) Reflect.deleteProperty(globalThis, key)
    }
    for (const [key, descriptor] of before) {
      const now = Reflect.getOwnPropertyDescriptor(globalThis, key)
      if (now === undefined || now.get !== descriptor.get || now.value !== descriptor.value) {
        Reflect.defineProperty(globalThis, key, descriptor)
      }
    }
  }
}

function setUp(options: JsdomEnvironmentOptions = {}): EnvironmentInstance {
  const instance = jsdomEnvironment.setup(context(options), prepared)
  assert.ok(!(instance instanceof Promise), 'the jsdom environment sets up synchronously')
  return instance
}

function tearDown(instance: EnvironmentInstance): void {
  assert.equal(instance.teardown(), undefined, 'a clean teardown reports nothing')
}

test('the environment is the jsdom one, in the worker realm only, prepared once', () => {
  assert.equal(jsdomEnvironment.name, 'jsdom')
  assert.deepEqual(jsdomEnvironment.realms, ['worker'])
  assert.equal(typeof jsdomEnvironment.prepare, 'function')
  assert.ok(typeof prepared === 'object' && prepared !== null)
})

test('a context realm is refused with a code', () => {
  assert.throws(
    () => jsdomEnvironment.setup(context({}, 'context'), prepared),
    (error: Error & { code?: string }) => error.code === 'ENV_JSDOM_REALM_UNSUPPORTED',
  )
})

test('setup without what prepare returned is refused with a code', () => {
  assert.throws(
    () => jsdomEnvironment.setup(context(), undefined),
    (error: Error & { code?: string }) => error.code === 'ENV_JSDOM_NOT_PREPARED',
  )
})

test('a window is on the global, with the defaults', () => {
  guarded(() => {
    const instance = setUp()
    assert.equal(instance.global, globalThis)
    const dom = globalThis as unknown as Window & typeof globalThis
    assert.equal(dom.window, globalThis)
    assert.equal(dom.self, globalThis)
    assert.equal(dom.document.defaultView, globalThis)
    assert.equal(dom.location.href, 'http://localhost:3000/')
    assert.equal(dom.document.body.tagName, 'BODY')
    const div = dom.document.createElement('div')
    assert.equal(div.tagName, 'DIV')
    assert.ok(div instanceof dom.HTMLElement)
    // jsdom's `requestAnimationFrame` exists with `pretendToBeVisual` (the default).
    assert.equal(typeof dom.requestAnimationFrame, 'function')
    tearDown(instance)
  })
})

test('url, html and userAgent options reach the window', () => {
  guarded(() => {
    const instance = setUp({
      url: 'https://example.test/path?q=1',
      html: '<!DOCTYPE html><p id="x">hi</p>',
      userAgent: 'provino-test',
    })
    const dom = globalThis as unknown as Window & typeof globalThis
    assert.equal(dom.location.href, 'https://example.test/path?q=1')
    assert.equal(dom.document.getElementById('x')?.textContent, 'hi')
    assert.equal(dom.navigator.userAgent, 'provino-test')
    tearDown(instance)
  })
})

test('the jsdom option passes through to the JSDOM constructor', () => {
  guarded(() => {
    const instance = setUp({ jsdom: { referrer: 'https://ref.test/' } })
    const dom = globalThis as unknown as Window & typeof globalThis
    assert.equal(dom.document.referrer, 'https://ref.test/')
    tearDown(instance)
  })
})

test('teardown restores the global: the same names and every original descriptor', () => {
  guarded(() => {
    const before = properties()
    const instance = setUp()
    Reflect.set(globalThis, 'leakedByTest', 1)
    Reflect.set(globalThis, Symbol.for('leakedByTest'), 2)
    tearDown(instance)
    const after = properties()
    assert.deepEqual(new Set(after.keys()), new Set(before.keys()), 'the same property names')
    for (const [key, descriptor] of before) {
      assert.deepStrictEqual(after.get(key), descriptor, `descriptor of ${String(key)}`)
    }
    assert.equal(Reflect.has(globalThis, 'window'), false)
    assert.equal(Reflect.has(globalThis, 'document'), false)
  })
})

test('every file gets a window of its own', () => {
  guarded(() => {
    const first = setUp({ html: '<!DOCTYPE html><p id="a"></p>' })
    const dom = globalThis as unknown as Window & typeof globalThis
    assert.ok(dom.document.getElementById('a'))
    tearDown(first)
    const second = setUp()
    assert.equal(dom.document.getElementById('a'), null)
    tearDown(second)
  })
})

test('teardown closes the window', () => {
  guarded(() => {
    const instance = setUp()
    const dom = globalThis as unknown as { readonly jsdom: { readonly window: { close(): void } } }
    const win = dom.jsdom.window
    const close = win.close.bind(win)
    let closes = 0
    win.close = () => {
      closes++
      close()
    }
    tearDown(instance)
    assert.equal(closes, 1)
  })
})

/** Runs `body` with `uncaughtException` going to `seen` alone (node:test has its own handler). */
function catchingUncaught(body: (seen: unknown[]) => void): void {
  const saved = process.listeners('uncaughtException')
  const seen: unknown[] = []
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', (error) => seen.push(error))
  try {
    body(seen)
  } finally {
    process.removeAllListeners('uncaughtException')
    for (const listener of saved) process.on('uncaughtException', listener)
  }
}

test('an error event nobody listens for becomes an uncaught exception, and is prevented', () => {
  guarded(() => {
    catchingUncaught((seen) => {
      const instance = setUp()
      const dom = globalThis as unknown as Window & typeof globalThis
      const error = new Error('boom')
      const event = new dom.ErrorEvent('error', { error, cancelable: true })
      dom.dispatchEvent(event)
      assert.deepEqual(seen, [error])
      assert.equal(event.defaultPrevented, true)
      tearDown(instance)
    })
  })
})

test('with a listener of its own the error event is the test`s, not the process`s', () => {
  guarded(() => {
    catchingUncaught((seen) => {
      const instance = setUp()
      const dom = globalThis as unknown as Window & typeof globalThis
      const heard: unknown[] = []
      const listener = (event: Event): void => {
        heard.push((event as ErrorEvent).error)
      }
      dom.addEventListener('error', listener)
      const error = new Error('seen by the test')
      dom.dispatchEvent(new dom.ErrorEvent('error', { error }))
      assert.deepEqual(heard, [error])
      assert.deepEqual(seen, [])
      // After removal the bridge is back.
      dom.removeEventListener('error', listener)
      dom.dispatchEvent(new dom.ErrorEvent('error', { error }))
      assert.deepEqual(seen, [error])
      tearDown(instance)
    })
  })
})

test('Node`s fetch API is the window`s, so a Response from fetch is the one the test sees', () => {
  guarded(() => {
    const nodeResponse = globalThis.Response
    const nodeHeaders = globalThis.Headers
    const instance = setUp()
    assert.equal(globalThis.Response, nodeResponse)
    assert.equal(globalThis.Headers, nodeHeaders)
    tearDown(instance)
  })
})

test('a populated key the test made non-configurable is reported, and the rest is restored (D22)', () => {
  // A non-configurable key can never be removed from the real global, so this runs in a child.
  const index = new URL('./index.ts', import.meta.url).href
  const script = `
    import { jsdomEnvironment } from ${JSON.stringify(index)}
    const prepared = await jsdomEnvironment.prepare({})
    const instance = await jsdomEnvironment.setup(
      { options: {}, realm: 'worker', scope: 'file', testPath: '/a.test.ts', pragmas: {}, console, signal: new AbortController().signal },
      prepared,
    )
    Object.defineProperty(globalThis, 'HTMLElement', { value: 1, configurable: false })
    const report = instance.teardown()
    const left = ['window', 'self', 'top', 'parent', 'document'].filter((key) => Reflect.has(globalThis, key))
    console.log('RESULT ' + JSON.stringify({ report, left }))
  `
  const output = execFileSync(
    process.execPath,
    ['--conditions=provino-source', '--input-type=module', '--eval', script],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const line = output.split('\n').find((text) => text.startsWith('RESULT '))
  assert.ok(line !== undefined, output)
  const result = JSON.parse(line.slice('RESULT '.length)) as {
    report: { leakedGlobals: string[] } | undefined
    left: string[]
  }
  assert.deepEqual(result.report?.leakedGlobals, ['HTMLElement'])
  assert.deepEqual(result.left, [], 'window, self, top, parent and document are gone')
})

test('teardown restores the global even when closing the window throws', () => {
  guarded(() => {
    const before = properties()
    const instance = setUp()
    const dom = globalThis as unknown as { readonly jsdom: { readonly window: { close(): void } } }
    dom.jsdom.window.close = () => {
      throw new Error('close failed')
    }
    assert.throws(() => instance.teardown(), /close failed/)
    const after = properties()
    assert.deepEqual(new Set(after.keys()), new Set(before.keys()))
    for (const [key, descriptor] of before) {
      assert.deepStrictEqual(after.get(key), descriptor, `descriptor of ${String(key)}`)
    }
  })
})
