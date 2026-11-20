// One case per matcher (D188): it passes, it fails with Provino's message, and `.not` flips both.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  type ExpectError,
} from '@provino/expect'
import type { Assertion, ExpectStatic } from '@provino/types'
import { manualCurrentTest, testPolicy, testTask } from '../internal/test-support.ts'
import { provinoExpectTable } from './index.ts'
import { createMock } from './test-mock.ts'

function engine(): ExpectStatic {
  const current = manualCurrentTest()
  current.enter(testTask('t'))
  return createExpect({
    policy: testPolicy,
    table: provinoExpectTable(),
    source: createStateSource(current, { nameSeparator: ' > ', expand: false }),
    registry: createMatcherRegistry(),
  })
}
const expect = engine()

type Call = (assertion: Assertion, ...args: unknown[]) => unknown
const run = (name: string, received: unknown, args: readonly unknown[], not: boolean): void => {
  const target = not ? expect(received).not : expect(received)
  ;((target as unknown as Record<string, Call>)[name] as unknown as (...a: unknown[]) => void)(
    ...args,
  )
}

interface Row {
  readonly name: string
  readonly pass: readonly [received: unknown, ...args: unknown[]]
  readonly fail: readonly [received: unknown, ...args: unknown[]]
  /** Text the failure holds, besides the header. */
  readonly says: string
}

const fn = (impl: () => void) => impl
const mockCalled = (...calls: unknown[][]) => createMock(calls)

const rows: readonly Row[] = [
  { name: 'toBe', pass: [1, 1], fail: [1, 2], says: 'Expected: 2\nReceived: 1' },
  {
    name: 'toEqual',
    pass: [{ a: [1] }, { a: [1] }],
    fail: [{ a: 1 }, { a: 2 }],
    says: '- Expected',
  },
  {
    name: 'toStrictEqual',
    pass: [{ a: 1 }, { a: 1 }],
    fail: [{ a: undefined }, {}],
    says: 'Received:',
  },
  {
    name: 'toMatchObject',
    pass: [{ a: 1, b: 2 }, { a: 1 }],
    fail: [{ a: 1 }, { a: 2 }],
    says: 'Expected subset',
  },
  { name: 'toContain', pass: [[1, 2], 2], fail: [[1, 2], 3], says: 'Expected item: 3' },
  {
    name: 'toContainEqual',
    pass: [[{ a: 1 }], { a: 1 }],
    fail: [[{ a: 1 }], { a: 2 }],
    says: 'Expected item',
  },
  { name: 'toHaveLength', pass: ['ab', 2], fail: ['ab', 3], says: 'Received length: 2' },
  {
    name: 'toHaveProperty',
    pass: [{ a: { b: 1 } }, 'a.b', 1],
    fail: [{ a: { b: 1 } }, 'a.b', 2],
    says: 'Expected path: a.b',
  },
  { name: 'toBeTruthy', pass: [1], fail: [0], says: 'a truthy value' },
  { name: 'toBeFalsy', pass: [0], fail: [1], says: 'a falsy value' },
  { name: 'toBeNull', pass: [null], fail: [0], says: 'Expected: null' },
  { name: 'toBeUndefined', pass: [undefined], fail: [null], says: 'Expected: undefined' },
  { name: 'toBeDefined', pass: [0], fail: [undefined], says: 'a defined value' },
  { name: 'toBeNaN', pass: [Number.NaN], fail: [1], says: 'Expected: NaN' },
  { name: 'toBeGreaterThan', pass: [2, 1], fail: [1, 2], says: '> 2' },
  { name: 'toBeGreaterThanOrEqual', pass: [2, 2], fail: [1, 2], says: '>= 2' },
  { name: 'toBeLessThan', pass: [1, 2], fail: [2, 1], says: '< 1' },
  { name: 'toBeLessThanOrEqual', pass: [2, 2], fail: [3, 2], says: '<= 2' },
  { name: 'toBeCloseTo', pass: [0.1 + 0.2, 0.3], fail: [0.5, 0.3], says: 'Difference:' },
  { name: 'toMatch', pass: ['hello', /ell/], fail: ['hello', /xyz/], says: 'Expected pattern' },
  {
    name: 'toThrow',
    pass: [
      fn(() => {
        throw new Error('boom')
      }),
      'boom',
    ],
    fail: [fn(() => {}), 'boom'],
    says: 'Thrown: nothing',
  },
  {
    name: 'toBeInstanceOf',
    pass: [new Map(), Map],
    fail: [{}, Map],
    says: 'Expected constructor: Map',
  },
  { name: 'toBeTypeOf', pass: ['a', 'string'], fail: [1, 'string'], says: 'Received type: number' },
  {
    name: 'toSatisfy',
    pass: [4, (n: number) => n % 2 === 0],
    fail: [3, (n: number) => n % 2 === 0],
    says: 'predicate accepts',
  },
  { name: 'toHaveBeenCalled', pass: [mockCalled([1])], fail: [mockCalled()], says: 'Calls: none' },
  {
    name: 'toHaveBeenCalledTimes',
    pass: [mockCalled([1]), 1],
    fail: [mockCalled([1]), 2],
    says: 'Received calls: 1',
  },
  {
    name: 'toHaveBeenCalledWith',
    pass: [mockCalled([1, 2]), 1, 2],
    fail: [mockCalled([1, 2]), 3],
    says: '1: [ 1, 2 ]',
  },
  {
    name: 'toHaveBeenLastCalledWith',
    pass: [mockCalled([1], [2]), 2],
    fail: [mockCalled([1], [2]), 1],
    says: 'Calls:',
  },
  {
    name: 'toHaveBeenNthCalledWith',
    pass: [mockCalled([1], [2]), 2, 2],
    fail: [mockCalled([1], [2]), 2, 1],
    says: 'Call 2, expected',
  },
  {
    name: 'toHaveReturned',
    pass: [createMock([[]], [{ type: 'return', value: 1 }])],
    fail: [createMock([[]], [{ type: 'throw', value: 1 }])],
    says: 'at least one return',
  },
  {
    name: 'toHaveReturnedWith',
    pass: [createMock([[]], [{ type: 'return', value: 7 }]), 7],
    fail: [createMock([[]], [{ type: 'return', value: 7 }]), 8],
    says: 'Expected: 8',
  },
]

describe('the matchers of provinoExpectTable', () => {
  for (const row of rows) {
    test(row.name, () => {
      run(row.name, row.pass[0], row.pass.slice(1), false)
      assert.throws(
        () => run(row.name, row.fail[0], row.fail.slice(1), false),
        (error: Error) => {
          assert.ok(error.message.startsWith(`expect(received).${row.name}(`), error.message)
          assert.ok(error.message.includes(row.says), error.message)
          return true
        },
      )
      run(row.name, row.fail[0], row.fail.slice(1), true)
      assert.throws(
        () => run(row.name, row.pass[0], row.pass.slice(1), true),
        (error: Error) => {
          assert.ok(error.message.startsWith(`expect(received).not.${row.name}(`), error.message)
          return true
        },
      )
    })
  }

  test('a table row exists for every matcher the table has', () => {
    const named = new Set(rows.map((row) => row.name))
    for (const name of Object.keys(provinoExpectTable().matchers)) {
      assert.ok(named.has(name), `${name} has no row`)
    }
  })

  test('toThrow takes a class, an error, a pattern and an asymmetric matcher', () => {
    const boom = fn(() => {
      throw new TypeError('bad input')
    })
    expect(boom).toThrow()
    expect(boom).toThrow(TypeError)
    expect(boom).toThrow(/input/)
    expect(boom).toThrow(new TypeError('bad input'))
    expect(boom).toThrow(expect.objectContaining({ message: 'bad input' }))
    expect(boom).not.toThrow(RangeError)
    assert.throws(() => expect(boom).toThrow('other'), /Thrown: TypeError: bad input/)
  })

  test('toThrow reads the rejection under .rejects', async () => {
    await expect(Promise.reject(new Error('late'))).rejects.toThrow('late')
    await expect(Promise.reject(new Error('late'))).rejects.not.toThrow('early')
    await assert.rejects(
      async () => expect(Promise.resolve(fn(() => {}))).resolves.toThrow(),
      (error: ExpectError) => error.code === 'EXPECT_INVALID_ARGUMENT',
    )
  })

  test('a wrong argument is an ExpectError with a code, not a failed assertion', () => {
    for (const bad of [
      () => expect('a').toBeGreaterThan(1),
      () => expect(1).toHaveLength(1),
      () => expect(1).toHaveBeenCalled(),
      () => (expect(1) as unknown as Record<string, (v: string) => void>).toBeTypeOf?.('nope'),
      () => expect(1).toMatch('x'),
    ]) {
      assert.throws(bad, (error: ExpectError) => {
        assert.equal(error.code, 'EXPECT_INVALID_ARGUMENT')
        return true
      })
    }
  })

  test("toEqual keeps Jest's equality: undefined properties are ignored, toStrictEqual's are not", () => {
    expect({ a: 1, b: undefined }).toEqual({ a: 1 })
    assert.throws(() => expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }))
    const sparse: number[] = [1]
    sparse[2] = 3
    expect(sparse).toEqual([1, undefined, 3])
    assert.throws(() => expect(sparse).toStrictEqual([1, undefined, 3]))
  })

  test('a failed toEqual carries the values and a difference', () => {
    try {
      expect({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 3] })
      assert.fail('expected a failure')
    } catch (error) {
      const { message } = error as Error
      assert.match(message, /^expect\(received\)\.toEqual\(expected\)\n\nExpected: /)
      assert.match(message, /- Expected\n\+ Received/)
      assert.match(message, /^- .*3/m)
      assert.match(message, /^\+ .*2/m)
    }
  })
})
