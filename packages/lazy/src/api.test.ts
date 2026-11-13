// The forwarders: with no runtime installed every entry point throws `LAZY_NO_RUNTIME`; with one
// installed they reach it; and `LazyError` is recognised across copies of the module.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  currentLazyRuntime,
  evaluatedLazies,
  includeContext,
  includeExamples,
  installLazyRuntime,
  itBehavesLike,
  LAZY_CHAIN,
  LAZY_ERROR_CODES,
  LAZY_RUNTIME_SLOT,
  LazyError,
  type LazyRuntime,
  lazy,
  sharedContext,
  sharedExamples,
} from './index.ts'

function noRuntime(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof LazyError)
    assert.equal(error.code, 'LAZY_NO_RUNTIME')
    assert.match(error.message, /lazy values only work inside a test file Provino runs/)
    return true
  })
}

const calls: string[] = []
const fakeRuntime = {
  lazy: { name: 'root' },
  sharedExamples: (name: string) => {
    calls.push(`sharedExamples ${name}`)
    return { name }
  },
  itBehavesLike: () => {
    calls.push('itBehavesLike')
  },
  includeExamples: () => {
    calls.push('includeExamples')
  },
  sharedContext: (name: string) => {
    calls.push(`sharedContext ${name}`)
    return { name }
  },
  includeContext: ($: unknown) => $,
  evaluatedLazies: () => [],
} as unknown as LazyRuntime
Object.assign(fakeRuntime.lazy, {
  let: (key: string) => `let ${key}`,
  eager: (key: string) => `eager ${key}`,
  override: (key: string) => `override ${key}`,
  from: () => ({ from: true }),
})

describe('with no runtime installed', () => {
  test('there is no runtime', () => {
    assert.equal(currentLazyRuntime(), undefined)
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, LAZY_RUNTIME_SLOT), undefined)
  })

  test('lazy.let, eager, override and from throw LAZY_NO_RUNTIME', () => {
    noRuntime(() => lazy.let('a', () => 1))
    noRuntime(() => lazy.eager('a', () => 1))
    // @ts-expect-error the root handle has no key to override: the call is for the runtime check only
    noRuntime(() => lazy.override('a', () => 1))
    noRuntime(() => lazy.from({ task: {} }))
  })

  test('the shared-example and shared-context functions throw LAZY_NO_RUNTIME', () => {
    noRuntime(() => sharedExamples('group', () => {}))
    noRuntime(() => itBehavesLike({ name: 'group' }, {}))
    noRuntime(() => includeExamples({ name: 'group' }, {}))
    noRuntime(() => sharedContext('ctx', () => ({})))
    noRuntime(() => includeContext(lazy, { name: 'ctx' }))
    noRuntime(() => evaluatedLazies({} as never))
  })

  test('the root handle prints as a Lazy with no keys and never throws', () => {
    assert.equal(Object.prototype.toString.call(lazy), '[object Lazy]')
    assert.equal(JSON.stringify(lazy), '{"lazy":[]}')
    assert.ok(Object.isFrozen(lazy))
  })
})

describe('with a runtime installed', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    calls.length = 0
  })

  test('installLazyRuntime defines a non-enumerable, configurable slot, and uninstall removes it', () => {
    uninstall = installLazyRuntime(fakeRuntime)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, LAZY_RUNTIME_SLOT)
    assert.equal(descriptor?.enumerable, false)
    assert.equal(descriptor?.configurable, true)
    assert.equal(currentLazyRuntime(), fakeRuntime)
    assert.equal(LAZY_RUNTIME_SLOT, Symbol.for('provino.lazy.runtime'))
    uninstall()
    assert.equal(currentLazyRuntime(), undefined)
  })

  test('uninstall leaves a runtime installed after it alone', () => {
    const first = installLazyRuntime(fakeRuntime)
    const other = { ...fakeRuntime } as LazyRuntime
    uninstall = installLazyRuntime(other)
    first()
    assert.equal(currentLazyRuntime(), other)
  })

  test('the forwarders reach the installed runtime', () => {
    uninstall = installLazyRuntime(fakeRuntime)
    assert.equal(lazy.let('a', () => 1) as unknown, 'let a')
    assert.equal(lazy.eager('b', () => 1) as unknown, 'eager b')
    assert.deepEqual(lazy.from({ task: {} }), { from: true })
    sharedExamples('group', () => {})
    sharedContext('ctx', () => ({}))
    itBehavesLike({ name: 'group' }, {})
    includeExamples({ name: 'group' }, {})
    assert.deepEqual(calls, [
      'sharedExamples group',
      'sharedContext ctx',
      'itBehavesLike',
      'includeExamples',
    ])
  })
})

describe('LazyError', () => {
  test('carries a code, a site and every site', () => {
    const site = { file: '/a.test.ts', line: 3, column: 5 }
    const other = { file: '/a.test.ts', line: 9, column: 1 }
    const error = new LazyError('LAZY_SCOPE', 'a message', { sites: [site, other], cause: 'why' })
    assert.equal(error.name, 'LazyError')
    assert.equal(error.code, 'LAZY_SCOPE')
    assert.deepEqual(error.site, site)
    assert.deepEqual(error.sites, [site, other])
    assert.equal(error.cause, 'why')
    assert.ok(error instanceof Error)
  })

  test('a single site is the only site, and none is an empty list', () => {
    const site = { file: '/a.test.ts', line: 3, column: 5 }
    assert.deepEqual(new LazyError('LAZY_INVALID', 'm', { site }).sites, [site])
    assert.equal(new LazyError('LAZY_INVALID', 'm').site, undefined)
    assert.deepEqual(new LazyError('LAZY_INVALID', 'm').sites, [])
  })

  test('instanceof holds for an error from another copy of the module', async () => {
    const copy = await import(`./errors.ts?copy=${Date.now()}`)
    assert.notEqual(copy.LazyError, LazyError)
    assert.ok(new copy.LazyError('LAZY_NO_TEST', 'm') instanceof LazyError)
    assert.ok(new LazyError('LAZY_NO_TEST', 'm') instanceof copy.LazyError)
    assert.ok(!(new Error('m') instanceof LazyError))
    assert.ok(!({ code: 'LAZY_NO_TEST' } instanceof LazyError))
  })

  test('lists the 12 codes of Track 6 and two more, and names the chain symbol', () => {
    assert.equal(LAZY_ERROR_CODES.length, 14)
    assert.ok(LAZY_ERROR_CODES.includes('LAZY_NO_RUNTIME'))
    assert.ok(LAZY_ERROR_CODES.includes('LAZY_TIMEOUT'))
    assert.equal(LAZY_CHAIN, Symbol.for('provino.lazy.chain'))
  })
})
