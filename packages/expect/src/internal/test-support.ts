// Test helpers (not a test file). A neutral matcher table and a hand-driven current-test lookup,
// so the engine is tested without any dialect.
import { iterableEquality, subsetEquality } from '@jest/expect-utils'
import { neutralPolicy } from '@provino/policy'
import type {
  AsymmetricMatcherLike,
  CurrentTest,
  ExpectPolicy,
  ExpectStatic,
  ExpectTable,
  Frame,
  Matcher,
  MatcherCall,
  ModuleRef,
  TaskId,
  TestTask,
} from '@provino/types'
import { AsymmetricMatcher } from '../asymmetric.ts'
import type { MatcherContext } from '../context.ts'
import { createExpect } from '../expect.ts'
import { createMatcherRegistry, type MatcherRegistry } from '../slot.ts'
import { createStateSource, type StateSource } from '../state.ts'

/** The neutral policy's `expect` slice with the values B08 builds. */
export const testPolicy: ExpectPolicy = {
  ...neutralPolicy.expect,
  matcherTable: { module: 'test-support', export: 'table' } as ModuleRef<() => ExpectTable>,
  errorShape: 'matcher-result',
  equality: { errors: 'message', invalidDate: 'unequal' },
  soft: false,
  poll: { enabled: false, intervalMs: 50, timeoutMs: 1000 },
  requireAssertions: false,
}

const describeCall = ({ matcherName, isNot, promise }: MatcherCall): string =>
  `${promise}${isNot ? '.not' : ''}.${matcherName}`

/** `extend`'s asymmetric form in the test table. */
class TestCustom extends AsymmetricMatcher<readonly unknown[]> {
  readonly name: string
  readonly matcher: Matcher

  constructor(name: string, matcher: Matcher, inverse: boolean, sample: readonly unknown[]) {
    super(sample, inverse)
    this.name = name
    this.matcher = matcher
  }

  asymmetricMatch(other: unknown): boolean {
    const call = this.matcher as unknown as (
      this: MatcherContext,
      ...args: unknown[]
    ) => { pass: boolean }
    const { pass } = call.call(this.getMatcherContext(), other, ...this.sample)
    return this.inverse ? !pass : pass
  }

  toString(): string {
    return `${this.inverse ? 'not.' : ''}${this.name}`
  }
}

/** A matcher's `this`, typed for the test table. */
type Self = MatcherContext

/** A small table: enough matchers to drive every path of the engine, with recognisable text. */
export function testTable(): ExpectTable {
  return {
    matchers: {
      toBe(this: Self, received: unknown, expected: unknown) {
        return {
          pass: Object.is(received, expected),
          message: () =>
            `toBe${this.isNot ? ' not' : ''}: ${String(received)} vs ${String(expected)}`,
        }
      },
      toEqual(this: Self, received: unknown, expected: unknown) {
        return {
          pass: this.equals(received, expected, [...this.customTesters, iterableEquality]),
          message: () => `toEqual${this.isNot ? ' not' : ''}`,
        }
      },
      toMatchObject(this: Self, received: unknown, expected: unknown) {
        return {
          pass: this.equals(received, expected, [
            ...this.customTesters,
            iterableEquality,
            subsetEquality,
          ]),
          message: () => 'toMatchObject',
        }
      },
      toThrowNow(this: Self) {
        throw new Error('matcher blew up')
      },
      toPassLater(this: Self, received: unknown) {
        return Promise.resolve({ pass: received === 'later', message: () => 'toPassLater' })
      },
      toKeepGoing(this: Self, received: unknown) {
        this.dontThrow()
        return { pass: received === 'ok', message: () => 'toKeepGoing' }
      },
      toReadContext(this: Self) {
        lastContext = this
        return { pass: true, message: () => '' }
      },
    },
    promiseMatchers: {
      toBe(this: Self, received: unknown, expected: unknown) {
        return { pass: received === expected, message: () => `settled toBe: ${String(received)}` }
      },
    },
    asymmetric: {
      anything: () =>
        new TestCustom('anything', () => ({ pass: true, message: () => '' }), false, []),
    },
    asymmetricNot: {},
    utils: { tag: 'test-utils' },
    messages: {
      tooManyArguments: () => 'too many arguments',
      noMessage: () => 'no message',
      invalidResult: (result) => `invalid result: ${typeof result}`,
      notAPromise: (call) => `not a promise: ${describeCall(call)}`,
      rejectedInsteadOfResolved: (call, reason) =>
        `rejected instead of resolved: ${describeCall(call)} ${String(reason)}`,
      resolvedInsteadOfRejected: (call, value) =>
        `resolved instead of rejected: ${describeCall(call)} ${String(value)}`,
      invalidMatcher: (name) => `invalid matcher: ${name}`,
      invalidTesters: () => 'invalid testers',
      ensureNoExpected: (expected, name) => {
        if (expected !== undefined) throw new Error(`${name} takes no argument`)
      },
    },
    customAsymmetric: (name, matcher, inverse, sample) =>
      new TestCustom(name, matcher, inverse, sample),
  }
}

/** The context `toReadContext` saw last. */
export let lastContext: MatcherContext | undefined

/** A current-test lookup the test moves by hand. */
export interface ManualCurrentTest extends CurrentTest {
  /** Makes `test` (attempt `attempt`) current; `null` leaves no test running. */
  enter(test: TestTask | null, attempt?: number): void
}

/** A `CurrentTest` whose frame the test sets. */
export function manualCurrentTest(): ManualCurrentTest {
  let frame: Frame | undefined
  return {
    enter(test, attempt = 0) {
      frame = test === null ? undefined : { test, hook: null, fileId: 'f' as TaskId, attempt }
    },
    get: () => frame,
    run: (next, fn) => {
      const previous = frame
      frame = next
      try {
        return fn()
      } finally {
        frame = previous
      }
    },
    bind: (fn) => fn,
  }
}

/** A test task with the fields the engine reads. */
export function testTask(id: string, fullName: readonly string[] = [id]): TestTask {
  return {
    type: 'test',
    id,
    name: fullName.at(-1) ?? id,
    fullName,
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
  } as unknown as TestTask
}

/** An engine over the test table, with no slot installed. */
export interface TestEngine {
  readonly expect: ExpectStatic
  readonly source: StateSource
  readonly registry: MatcherRegistry
  readonly current: ManualCurrentTest
}

/** Builds an engine over `testTable()`. */
export function testEngine(): TestEngine {
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: ' > ', expand: false })
  const registry = createMatcherRegistry()
  const expect = createExpect({ policy: testPolicy, table: testTable(), source, registry })
  return { expect, source, registry, current }
}

/** An asymmetric matcher built on our base, for the interop cases (spike C). */
export class StartsWith extends AsymmetricMatcher<string> {
  asymmetricMatch(other: unknown): boolean {
    const result = typeof other === 'string' && other.startsWith(this.sample)
    return this.inverse ? !result : result
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}StartsWith`
  }
  override getExpectedType(): string {
    return 'string'
  }
  override toAsymmetricMatcher(): string {
    return `${this.toString()}<${this.sample}>`
  }
}

/**
 * An asymmetric matcher with only the protocol: no base class at all (spike C, F3). Jest's
 * pretty-format prints a matcher it doesn't know through `toAsymmetricMatcher()`, so a failure
 * without it throws "does not implement toAsymmetricMatcher()" instead of printing.
 */
export const isFortyTwo: AsymmetricMatcherLike = {
  $$typeof: Symbol.for('jest.asymmetricMatcher'),
  asymmetricMatch: (other: unknown) => other === 42,
  toString: () => 'IsFortyTwo',
  toAsymmetricMatcher: () => 'IsFortyTwo',
}

/** One engine's assertions, as the interop cases drive them. */
export interface InteropEngine {
  toEqual(received: unknown, expected: unknown): void
  notToEqual(received: unknown, expected: unknown): void
  toMatchObject(received: object, expected: object): void
}

/** An asymmetric matcher with a value it matches and one it doesn't. */
export interface InteropSubject {
  readonly name: string
  readonly matcher: unknown
  readonly good: unknown
  readonly bad: unknown
  /** Text a failing message shows for it, when the engine prints asymmetric matchers. */
  readonly printed?: string
}

/**
 * Spike C's six protocol cases for one subject. `printed` is checked when the engine's failure
 * message prints the expected value (Jest's does; Vitest's one-liner truncates it).
 */
export function interopCases(
  engine: InteropEngine,
  subject: InteropSubject,
): ReadonlyArray<readonly [string, () => void]> {
  const { matcher, good, bad, printed } = subject
  return [
    ['matches at the top level', () => engine.toEqual(good, matcher)],
    ['matches inside an object', () => engine.toEqual({ k: good }, { k: matcher })],
    ['matches inside an array', () => engine.toEqual([good], [matcher])],
    [
      'fails a value it doesn`t match',
      () => {
        let message: string | undefined
        try {
          engine.toEqual({ k: bad }, { k: matcher })
        } catch (error) {
          message = (error as Error).message
        }
        if (message === undefined) throw new Error('expected a failure')
        if (printed !== undefined && !message.includes(printed)) {
          throw new Error(`the failure doesn't print ${printed}:\n${message}`)
        }
      },
    ],
    ['passes .not for a value it doesn`t match', () => engine.notToEqual(bad, matcher)],
    [
      'matches inside toMatchObject',
      () => engine.toMatchObject({ k: good, extra: 1 }, { k: matcher }),
    ],
  ]
}
