import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Matcher } from '@provino/types'
import { ExpectError } from './errors.ts'
import { createExpect, MatcherResultError } from './expect.ts'
import {
  lastContext,
  testEngine,
  testPolicy,
  testTable,
  testTask,
} from './internal/test-support.ts'
import { createStateSource } from './state.ts'

/** A member the types don't list (a custom matcher, a missing one), as user code reaches it. */
type Loose<Name extends string> = Record<Name, (...args: unknown[]) => unknown>

/** Reads members by a name the types don't list. */
const member = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

/** The first stack frame of `error`. */
const topFrame = (error: unknown): string => String((error as Error).stack).split('\n')[1] ?? ''

describe('the lazy front end (T7.3)', () => {
  test('an unregistered matcher name reads undefined', () => {
    const { expect } = testEngine()
    assert.equal(member(expect(1)).toBeFoo, undefined)
    assert.equal(member(expect(1).not).toBeFoo, undefined)
    assert.equal(member(expect(1)).then, undefined)
    assert.equal(member(expect(1))[Symbol.iterator as unknown as string], undefined)
  })

  test('calling an unregistered name throws V8 is-not-a-function text', () => {
    const { expect } = testEngine()
    assert.throws(
      () => (expect(1) as unknown as Loose<'toBeCalled'>).toBeCalled(),
      new TypeError('expect(...).toBeCalled is not a function'),
    )
  })

  test('not, resolves and rejects resolve as in Jest, and nowhere else', () => {
    const { expect } = testEngine()
    const a = member(expect(1))
    assert.equal(member(a.not).not, undefined)
    assert.equal(member(a.not).resolves, undefined)
    assert.equal(member(a.not).rejects, undefined)
    assert.equal(member(a.resolves).resolves, undefined)
    assert.equal(member(a.resolves).rejects, undefined)
    assert.notEqual(member(a.resolves).not, undefined)
    assert.notEqual(member(a.rejects).not, undefined)
    assert.equal(typeof member(member(a.rejects).not).toBe, 'function')
  })

  test('expect takes one argument, with the dialect text', () => {
    const { expect } = testEngine()
    const call = expect as unknown as (a: unknown, b: unknown) => void
    assert.throws(() => call(1, 2), { message: 'too many arguments' })
  })
})

describe('a matcher call (Jest makeThrowingMatcher)', () => {
  test('a pass counts a call and a passing assertion', () => {
    const { expect, source } = testEngine()
    expect(1).toBe(1)
    expect(1).not.toBe(2)
    assert.equal(source.current().assertionCalls, 2)
    assert.equal(source.current().numPassingAsserts, 2)
  })

  test('a failure throws a MatcherResultError named Error, with the result attached', () => {
    const { expect, source } = testEngine()
    const error = captured(() => expect(1).toBe(2))
    assert.ok(error instanceof MatcherResultError)
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'toBe: 1 vs 2')
    assert.equal(error.matcherResult?.pass, false)
    assert.equal(error.matcherResult?.message, 'toBe: 1 vs 2')
    assert.equal(source.current().assertionCalls, 1)
    assert.equal(source.current().numPassingAsserts, 0)
  })

  test('the failure is anchored at the caller, never in the engine', () => {
    const { expect } = testEngine()
    const error = captured(() => expect(1).toBe(2))
    assert.match(topFrame(error), /expect\.test\.ts/)
    assert.match(String((error as Error).stack), /^Error: toBe: 1 vs 2\n/)
  })

  test('.not passes isNot to the matcher and fails a pass', () => {
    const { expect } = testEngine()
    assert.throws(() => expect(1).not.toBe(1), { message: 'toBe not: 1 vs 1' })
  })

  test('the context carries the state, equality, utils and the call', () => {
    const { expect, current } = testEngine()
    current.enter(testTask('t1', ['outer', 'inner']))
    const read = (expect(1) as unknown as Loose<'toReadContext'>).toReadContext
    read()
    assert.equal(lastContext?.isNot, false)
    assert.equal(lastContext?.promise, '')
    assert.equal(lastContext?.currentTestName, 'outer > inner')
    assert.deepEqual(lastContext?.utils, { tag: 'test-utils' })
    assert.equal(typeof lastContext?.equals, 'function')
    assert.equal(lastContext?.error, undefined)
  })

  test('a result without a message fails with the no-message text', () => {
    const { expect } = testEngine()
    expect.extend({ toBeQuiet: () => ({ pass: false }) as never })
    assert.throws(() => (expect(1) as unknown as Loose<'toBeQuiet'>).toBeQuiet(), {
      message: 'no message',
    })
  })

  test('a string message throws Jest`s TypeError, anchored at the caller', () => {
    const { expect } = testEngine()
    expect.extend({ toSayText: () => ({ pass: false, message: 'text' }) as never })
    const error = captured(() => (expect(1) as unknown as Loose<'toSayText'>).toSayText())
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, 'message is not a function')
  })

  test('a falsy message that isn`t a function still means no message, as in Jest', () => {
    const { expect } = testEngine()
    expect.extend({ toSayNothing: () => ({ pass: false, message: '' }) as never })
    assert.throws(() => (expect(1) as unknown as Loose<'toSayNothing'>).toSayNothing(), {
      message: 'no message',
    })
  })

  test('a null result throws the TypeError Jest`s result check hits, not the invalid-result text', () => {
    const { expect } = testEngine()
    expect.extend({ toReturnNull: () => null as never })
    const error = captured(() => (expect(1) as unknown as Loose<'toReturnNull'>).toReturnNull())
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, "Cannot read properties of null (reading 'pass')")
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('an invalid result fails with the dialect text', () => {
    const { expect } = testEngine()
    expect.extend({ toReturnNothing: () => undefined as never })
    assert.throws(() => (expect(1) as unknown as Loose<'toReturnNothing'>).toReturnNothing(), {
      message: 'invalid result: undefined',
    })
  })

  test('dontThrow records the failure in suppressedErrors instead', () => {
    const { expect, source } = testEngine()
    const keepGoing = (expect('no') as unknown as Loose<'toKeepGoing'>).toKeepGoing
    keepGoing()
    const [suppressed] = source.current().suppressedErrors
    assert.ok(suppressed instanceof MatcherResultError)
    assert.equal(suppressed.message, 'toKeepGoing')
  })

  test('an internal matcher that throws is re-anchored at the caller', () => {
    const { expect } = testEngine()
    const error = captured(() => (expect(1) as unknown as Loose<'toThrowNow'>).toThrowNow())
    assert.equal((error as Error).message, 'matcher blew up')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('a custom matcher runs inside __EXTERNAL_MATCHER_TRAP__ and keeps its own stack', () => {
    const { expect } = testEngine()
    const blowUp: Matcher = () => {
      throw new Error('custom blew up')
    }
    expect.extend({ toBlowUp: blowUp })
    const error = captured(() => (expect(1) as unknown as Loose<'toBlowUp'>).toBlowUp())
    assert.match(String((error as Error).stack), /__EXTERNAL_MATCHER_TRAP__/)
  })

  test('an async matcher result is awaited, counted and anchored', async () => {
    const { expect, source } = testEngine()
    const later = (value: string) =>
      (expect(value) as unknown as Loose<'toPassLater'>).toPassLater()
    await later('later')
    const error = await rejection(later('sooner'))
    assert.equal((error as Error).message, 'toPassLater')
    assert.match(topFrame(error), /expect\.test\.ts/)
    assert.equal(source.current().assertionCalls, 2)
    assert.equal(source.current().numPassingAsserts, 1)
  })
})

describe('.resolves and .rejects', () => {
  test('resolves runs the promise matcher on the value', async () => {
    const { expect } = testEngine()
    await expect(Promise.resolve(1)).resolves.toBe(1)
    const error = await rejection(expect(Promise.resolve(2)).resolves.toBe(1))
    assert.equal((error as Error).message, 'settled toBe: 2')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('a function returning a promise is called', async () => {
    const { expect } = testEngine()
    await expect(() => Promise.resolve(1)).resolves.toBe(1)
  })

  test('rejects runs the matcher on the reason', async () => {
    const { expect } = testEngine()
    await expect(Promise.reject(3)).rejects.toBe(3)
    await expect(Promise.reject(3)).rejects.not.toBe(4)
  })

  test('the wrong settlement throws the error made when .resolves was read', async () => {
    const { expect } = testEngine()
    const pending = expect(Promise.reject(new Error('no'))).resolves.toBe(1)
    const error = await rejection(pending)
    assert.ok(error instanceof MatcherResultError)
    assert.equal(error.message, 'rejected instead of resolved: resolves.toBe Error: no')
    assert.match(topFrame(error), /expect\.test\.ts/)
    const reverse = await rejection(expect(Promise.resolve(5)).rejects.not.toBe(1))
    assert.equal((reverse as Error).message, 'resolved instead of rejected: rejects.not.toBe 5')
  })

  test('a non-promise fails synchronously with the dialect text', () => {
    const { expect } = testEngine()
    const error = captured(() => {
      void expect(1).resolves.toBe(1)
    })
    assert.ok(error instanceof MatcherResultError)
    assert.equal(error.message, 'not a promise: resolves.toBe')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('a custom matcher named like an Object.prototype method is the one used under resolves', async () => {
    const { expect } = testEngine()
    const calls: unknown[] = []
    expect.extend({
      toString: (received: unknown) => {
        calls.push(received)
        return { pass: true, message: () => '' }
      },
    })
    await (expect(Promise.resolve(7)).resolves as unknown as Loose<'toString'>).toString()
    assert.deepEqual(calls, [7])
  })

  test('an extended matcher works under resolves when the table has no promise form', async () => {
    const { expect } = testEngine()
    await (expect(Promise.resolve(1)).resolves as unknown as Loose<'toEqual'>).toEqual(1)
  })
})

describe('statics', () => {
  test('extend registers the matcher, its asymmetric form and its inverse', () => {
    const { expect, registry } = testEngine()
    const toBeEven: Matcher = (received: number) => ({
      pass: received % 2 === 0,
      message: () => 'toBeEven',
    })
    expect.extend({ toBeEven })
    assert.equal(registry.matchers.toBeEven, toBeEven)
    ;(expect(2) as unknown as Loose<'toBeEven'>).toBeEven()
    const even = (expect as unknown as Loose<'toBeEven'>).toBeEven()
    const odd = (expect.not as unknown as Loose<'toBeEven'>).toBeEven()
    expect([2, 3]).toEqual([even, odd])
    assert.equal(String(odd), 'not.toBeEven')
  })

  test('extend rejects a non-function with the dialect text', () => {
    const { expect } = testEngine()
    assert.throws(() => expect.extend({ bad: 1 as never }), {
      name: 'TypeError',
      message: 'invalid matcher: bad',
    })
  })

  test('addEqualityTesters adds testers equality uses, and rejects a non-array', () => {
    const { expect, registry } = testEngine()
    expect.addEqualityTesters([(a, b) => (a === 'x' && b === 'y' ? true : undefined)])
    expect('x').toEqual('y')
    assert.equal(registry.customEqualityTesters.length, 1)
    assert.throws(() => expect.addEqualityTesters(1 as never), {
      name: 'TypeError',
      message: 'invalid testers',
    })
  })

  test('assertions and hasAssertions record the expectation and where it was made', () => {
    const { expect, source } = testEngine()
    expect.assertions(2)
    expect.hasAssertions()
    const state = source.current()
    assert.equal(state.expectedAssertionsNumber, 2)
    assert.equal(state.isExpectingAssertions, true)
    assert.match(topFrame(state.expectedAssertionsNumberError), /expect\.test\.ts/)
    assert.match(topFrame(state.isExpectingAssertionsError), /expect\.test\.ts/)
  })

  test('hasAssertions with an argument throws the dialect error, anchored at the caller', () => {
    const { expect } = testEngine()
    const call = expect.hasAssertions as unknown as (x: unknown) => void
    const error = captured(() => call(1))
    assert.equal((error as Error).message, '.hasAssertions takes no argument')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('getState is the live current state, and setState merges into it', () => {
    const { expect, source } = testEngine()
    expect.setState({ custom: 1 })
    assert.equal(expect.getState(), source.current())
    assert.equal(expect.getState().custom, 1)
  })

  test('the table`s asymmetric factories are on expect', () => {
    const { expect } = testEngine()
    expect({ a: 1 }).toEqual({ a: expect.anything() })
  })
})

describe('the policy values B08 builds', () => {
  const source = createStateSource(
    { get: () => undefined, run: (_f, fn) => fn(), bind: (fn) => fn },
    {
      nameSeparator: ' ',
      expand: false,
    },
  )

  test('a null matcher table throws EXPECT_NO_MATCHER_TABLE', () => {
    assert.throws(
      () =>
        createExpect({ policy: { ...testPolicy, matcherTable: null }, table: testTable(), source }),
      (error: unknown) => error instanceof ExpectError && error.code === 'EXPECT_NO_MATCHER_TABLE',
    )
  })

  for (const [key, override] of [['errorShape', { errorShape: 'assertion-error' }]] as const) {
    test(`${key} not yet built throws EXPECT_NOT_IMPLEMENTED`, () => {
      assert.throws(
        () => createExpect({ policy: { ...testPolicy, ...override }, table: testTable(), source }),
        (error: unknown) =>
          error instanceof ExpectError &&
          error.code === 'EXPECT_NOT_IMPLEMENTED' &&
          error.message.includes(key.split('.')[0] ?? key),
      )
    })
  }
})

describe('the assertion object, as Jest`s plain object (B08 review)', () => {
  test('its keys are not, rejects, resolves and the matchers, in Jest`s order', () => {
    const { expect, registry } = testEngine()
    const names = Object.keys(registry.matchers)
    assert.deepEqual(Object.keys(expect(1)), ['not', 'rejects', 'resolves', ...names])
    assert.deepEqual(Object.keys(expect(1).not), names)
    assert.deepEqual(Object.keys(expect(Promise.resolve(1)).resolves), ['not', ...names])
    assert.deepEqual(Object.keys(expect(Promise.resolve(1)).resolves.not), names)
    assert.equal('toBe' in expect(1), true)
    assert.equal('toBeFoo' in expect(1), false)
  })

  test('Object.prototype members read through, so String() and inspect work', () => {
    const { expect } = testEngine()
    assert.equal(String(expect(1)), '[object Object]')
    assert.equal(member(expect(1)).hasOwnProperty, Object.prototype.hasOwnProperty)
    assert.equal(member(expect(1)).then, undefined)
  })

  test('a wrapper that walks the keys, as jest-expect-message does, works', () => {
    const { expect } = testEngine()
    const wrap = (object: object): void => {
      for (const key of Object.keys(object)) {
        const value: unknown = Reflect.get(object, key)
        // jest-expect-message's `wrapMatchers` recurses into every value that isn't a function.
        if (typeof value !== 'function') wrap(value as object)
      }
    }
    wrap(expect(1) as unknown as object)
  })
})

describe('frames on the async paths (B08 review)', () => {
  test('a built-in matcher`s error under .resolves points at the caller', async () => {
    const { expect } = testEngine()
    const error = await rejection(
      (expect(Promise.resolve(1)).resolves as unknown as Loose<'toThrowNow'>).toThrowNow(),
    )
    assert.equal((error as Error).message, 'promise form blew up')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('an async custom matcher`s invalid result keeps a stack that reaches the caller', async () => {
    const { expect } = testEngine()
    expect.extend({ toBeLate: async () => ({}) as never })
    const error = await rejection((expect(1) as unknown as Loose<'toBeLate'>).toBeLate())
    assert.equal((error as Error).message, 'invalid result: object')
    assert.match(String((error as Error).stack), /expect\.test\.ts/)
  })

  test('extend(undefined) throws Object.keys` TypeError at the caller', () => {
    const { expect } = testEngine()
    const error = captured(() => expect.extend(undefined as never))
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, 'Cannot convert undefined or null to object')
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('a thenable whose then returns nothing throws at the caller', () => {
    const { expect } = testEngine()
    // biome-ignore lint/suspicious/noThenProperty: the case is a thenable whose `then` returns nothing
    expect.extend({ toBeThenable: () => ({ then() {} }) as never })
    const error = captured(() => (expect(1) as unknown as Loose<'toBeThenable'>).toBeThenable())
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, "Cannot read properties of undefined (reading 'catch')")
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('an error a custom matcher`s message throws keeps its own frames', () => {
    const { expect } = testEngine()
    expect.extend({
      toSayBoom: () => ({
        pass: false,
        message: function boomMessage(): string {
          throw new Error('boom')
        },
      }),
    })
    const error = captured(() => (expect(1) as unknown as Loose<'toSayBoom'>).toSayBoom())
    assert.match(topFrame(error), /boomMessage/)
  })
})

describe('deliberate differences from Jest (docs/plan/DIVERGENCES.md)', () => {
  test('a primitive thrown inside a built-in matcher is rethrown as it is', () => {
    const { expect } = testEngine()
    expect.addEqualityTesters([
      () => {
        throw null
      },
    ])
    // Jest's handleError reads `.name` of it and throws a TypeError instead (index.ts L357).
    assert.throws(
      () => expect(1).toEqual(2),
      (error: unknown) => error === null,
    )
  })

  test('.not and each matcher read fresh on every access', () => {
    const { expect } = testEngine()
    const assertion = expect(1)
    // Jest builds them once per expect() call, so both are === there.
    assert.notEqual(assertion.not, assertion.not)
    assert.notEqual(assertion.toBe, assertion.toBe)
  })
})

describe('Jest`s smaller details (B08 review)', () => {
  test('.resolves counts into the state of the test that called it', async () => {
    const { expect, source, current } = testEngine()
    const a = testTask('a')
    let settle: (value: number) => void = () => {}
    const thenable = new Promise<number>((resolve) => {
      settle = resolve
    })
    current.enter(a)
    const pending = expect(thenable).resolves.toBe(1)
    current.enter(null)
    settle(1)
    await pending
    assert.equal(source.stateOf('a', { attempt: 0, repeat: 0 })?.numPassingAsserts, 1)
    assert.equal(source.file().numPassingAsserts, 0)
  })

  test('extend with a built-in throws Jest`s TypeError instead of demoting it', () => {
    const { expect, registry } = testEngine()
    assert.throws(() => expect.extend({ toBeAlias: registry.matchers.toBe as never }), {
      name: 'TypeError',
      message: 'Cannot redefine property: Symbol($$jest-internal-matcher)',
    })
    const error = captured(() => (expect(1) as unknown as Loose<'toThrowNow'>).toThrowNow())
    assert.match(topFrame(error), /expect\.test\.ts/)
  })

  test('extend with a frozen function throws Jest`s TypeError', () => {
    const { expect } = testEngine()
    const frozen = Object.freeze(() => ({ pass: true, message: () => '' }))
    assert.throws(() => expect.extend({ toBeFrozen: frozen }), {
      name: 'TypeError',
      message: 'Cannot define property Symbol($$jest-internal-matcher), object is not extensible',
    })
  })

  test('the error has an own matcherResult, set or not, as JestAssertionError does', async () => {
    const { expect } = testEngine()
    const error = await rejection(expect(Promise.reject(new Error('no'))).resolves.toBe(1))
    assert.deepEqual(Object.keys(error as object), ['matcherResult', 'message'])
    assert.deepEqual(Object.keys(new MatcherResultError('x')), ['matcherResult'])
  })

  test('dontThrow returns false, as Jest`s does', () => {
    const { expect } = testEngine()
    let returned: unknown
    expect.extend({
      toKeepQuiet(this: { dontThrow(): unknown }) {
        returned = this.dontThrow()
        return { pass: true, message: () => '' }
      },
    } as never)
    ;(expect(1) as unknown as Loose<'toKeepQuiet'>).toKeepQuiet()
    assert.equal(returned, false)
  })
})

/** What `fn` throws. */
function captured(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected a throw')
}

/** What `promise` rejects with. */
async function rejection(promise: unknown): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected a rejection')
}
