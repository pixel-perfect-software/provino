// The equality policies (T7.7): `errors: 'assert'` and `invalidDate: 'equal'` as testers ahead of
// `equals`. The corpus cases against both runners' verdicts are `@provino/harness`'s
// `equality-corpus.test.ts`; these are the testers on their own.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { ExpectPolicy, ExpectStatic } from '@provino/types'
import { equalityTesters } from './equality.ts'
import { createExpect } from './expect.ts'
import { lastContext, manualCurrentTest, testPolicy, testTable } from './internal/test-support.ts'
import { createMatcherRegistry } from './slot.ts'
import { createStateSource } from './state.ts'

const JEST: ExpectPolicy['equality'] = { errors: 'message', invalidDate: 'unequal' }
const VITEST: ExpectPolicy['equality'] = { errors: 'assert', invalidDate: 'equal' }

function expectWith(equality: ExpectPolicy['equality']): ExpectStatic {
  const source = createStateSource(manualCurrentTest(), { nameSeparator: ' ', expand: false })
  return createExpect({
    policy: { ...testPolicy, equality },
    table: testTable(),
    source,
    registry: createMatcherRegistry(),
  })
}

const passes = (run: () => void): boolean => {
  try {
    run()
    return true
  } catch {
    return false
  }
}

const there = (code: string): never => runInNewContext(code) as never

describe('equalityTesters', () => {
  test('Jest`s policy asks for none, and each rule asks for its own', () => {
    assert.equal(equalityTesters(JEST).length, 0)
    assert.equal(equalityTesters({ errors: 'assert', invalidDate: 'unequal' }).length, 1)
    assert.equal(equalityTesters({ errors: 'message', invalidDate: 'equal' }).length, 1)
    assert.equal(equalityTesters(VITEST).length, 2)
  })

  test('createExpect puts them ahead of the testers the user adds', () => {
    const expect = expectWith(VITEST)
    const mine = (): undefined => undefined
    expect.addEqualityTesters([mine])
    ;(expect(1) as unknown as { toReadContext(): void }).toReadContext()
    const testers = lastContext?.customTesters ?? []
    assert.equal(testers.length, 3)
    assert.equal(testers.at(-1), mine)
  })
})

describe('errors: assert', () => {
  const vitest = expectWith(VITEST)
  const jest = expectWith(JEST)
  const equal = (e: ExpectStatic, a: unknown, b: unknown) => passes(() => e(a).toEqual(b))

  test('the same class, name and message are equal; Jest`s policy agrees', () => {
    assert.equal(equal(vitest, new Error('same'), new Error('same')), true)
    assert.equal(equal(jest, new Error('same'), new Error('same')), true)
  })

  test('another class with the same message is not, where Jest`s policy says it is', () => {
    assert.equal(equal(vitest, new Error('a'), new TypeError('a')), false)
    assert.equal(equal(jest, new Error('a'), new TypeError('a')), true)
  })

  test('a different message is not equal under either', () => {
    assert.equal(equal(vitest, new Error('a'), new Error('b')), false)
    assert.equal(equal(jest, new Error('a'), new Error('b')), false)
  })

  test('the expected error`s cause must match, and a cause only the received one has is ignored', () => {
    assert.equal(equal(vitest, new Error('a', { cause: 1 }), new Error('a', { cause: 2 })), false)
    assert.equal(equal(vitest, new Error('a', { cause: 1 }), new Error('a', { cause: 1 })), true)
    assert.equal(equal(vitest, new Error('a', { cause: 1 }), new Error('a')), true)
    assert.equal(equal(vitest, new Error('a'), new Error('a', { cause: 1 })), false)
  })

  test('own enumerable properties must match', () => {
    assert.equal(equal(vitest, Object.assign(new Error('a'), { code: 1 }), new Error('a')), false)
    assert.equal(
      equal(
        vitest,
        Object.assign(new Error('a'), { code: 1 }),
        Object.assign(new Error('a'), { code: 1 }),
      ),
      true,
    )
  })

  test('the errors of an AggregateError are compared', () => {
    const one = (message: string) => new AggregateError([new Error(message)], 'agg')
    assert.equal(equal(vitest, one('x'), one('x')), true)
    assert.equal(equal(vitest, one('x'), one('y')), false)
    assert.equal(equal(jest, one('x'), one('y')), true)
  })

  test('works for errors nested in other values', () => {
    assert.equal(equal(vitest, { e: new Error('a') }, { e: new TypeError('a') }), false)
    assert.equal(equal(vitest, [new Error('a')], [new Error('a')]), true)
  })

  test('an error that is its own cause ends the walk', () => {
    const loop = (): Error => {
      const error = new Error('loop')
      error.cause = error
      return error
    }
    assert.equal(equal(vitest, loop(), loop()), true)
  })

  test('judges an error from another realm by its class, not its constructor', () => {
    assert.equal(equal(vitest, there('new RangeError("r")'), new RangeError('r')), true)
    assert.equal(equal(vitest, there('new RangeError("r")'), new TypeError('r')), false)
  })

  test('leaves what isn`t an error to Jest`s equals', () => {
    assert.equal(equal(vitest, { a: 1 }, { a: 1 }), true)
    assert.equal(equal(vitest, new Error('a'), { message: 'a' }), false)
  })
})

describe('invalidDate: equal', () => {
  const vitest = expectWith(VITEST)
  const jest = expectWith(JEST)
  const equal = (e: ExpectStatic, a: unknown, b: unknown) => passes(() => e(a).toEqual(b))

  test('two invalid dates are equal, where Jest`s policy says they are not', () => {
    assert.equal(equal(vitest, new Date('x'), new Date('y')), true)
    assert.equal(equal(jest, new Date('x'), new Date('y')), false)
  })

  test('a valid date and an invalid one are not, and valid dates are compared as before', () => {
    assert.equal(equal(vitest, new Date(1), new Date('y')), false)
    assert.equal(equal(vitest, new Date(1), new Date(1)), true)
    assert.equal(equal(vitest, new Date(1), new Date(2)), false)
  })

  test('works for dates nested in other values and from another realm', () => {
    assert.equal(equal(vitest, { when: new Date('x') }, { when: new Date('y') }), true)
    assert.equal(equal(vitest, there('new Date("x")'), new Date('y')), true)
  })
})
