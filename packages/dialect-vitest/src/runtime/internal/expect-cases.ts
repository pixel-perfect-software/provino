// The cases `expect-table.test.ts` runs through both this dialect's table and the real
// `@vitest/expect` 5.0.5 (in a child, `expect-oracle.ts`): every jest-style matcher the table
// vendors, passing and failing, with `.not`, plus the custom matchers and the asymmetric ones
// inside an equality. No spies: the two sides' mock functions differ (`@provino/mock` here,
// `@vitest/spy` there), and the message corpus holds the spy matchers to Vitest's recordings.

/**
 * One assertion: `expect(received())[.not][matcher](...args())`. A dotted `matcher` is a Chai chain
 * (`to.deep.equal`): every name but the last is read, the last is called.
 */
export function runCase(side: Side, c: ExpectCase): unknown {
  if (c.run !== undefined) return c.run(side)
  const { expect } = side
  let target = expect(c.received()) as unknown as Record<string, unknown>
  if (c.not) target = target.not as Record<string, unknown>
  const names = c.matcher.split('.')
  const last = names.pop() ?? ''
  for (const name of names) target = target[name] as Record<string, unknown>
  return (target[last] as (...args: readonly unknown[]) => unknown).call(
    target,
    ...(c.args?.() ?? []),
  )
}

/** A name a script reads on an assertion: a further chain, and callable. */
export interface Link extends Chain {
  (...args: readonly unknown[]): Chain
}

/** What the script cases read on an assertion (`runCase` reads the table cases' names loosely). */
export interface Chain {
  readonly equal: Link
  readonly rejects: Link
  readonly resolves: Link
  readonly to: Link
  readonly toBe: Link
  readonly toEqual: Link
  readonly toEqualByThisEquals: Link
  readonly toMatchObject: Link
  readonly toShowContext: Link
  readonly toStrictEqual: Link
  readonly toThrow: Link
  readonly toThrowError: Link
}

/** What a custom matcher of a case reads on its `this`. */
export interface CaseContext {
  equals(a: unknown, b: unknown): boolean
  readonly soft?: boolean
  readonly poll?: boolean
  readonly promise: string
}

/** A custom matcher a case registers. */
export type CaseMatcher = (
  this: CaseContext,
  received: unknown,
  expected: unknown,
) => { readonly pass: boolean; readonly message: () => string }

/** What a case runs on: the side's `expect` and its `expect.extend`. */
export interface Side {
  readonly expect: (actual: unknown, message?: string) => Chain
  readonly extend: (matchers: Readonly<Record<string, CaseMatcher>>) => void
}

export interface ExpectCase {
  readonly matcher: string
  readonly received: () => unknown
  readonly args?: () => readonly unknown[]
  readonly not?: boolean
  /** A case that is a script of its own (a sequence, an `await`); its value is awaited. */
  readonly run?: (side: Side) => unknown
}

/** A script case: `matcher` names it in a failure. */
const script = (matcher: string, run: (side: Side) => unknown): ExpectCase => ({
  matcher,
  received: () => undefined,
  run,
})

const tag = Symbol.toStringTag

class Point {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

/** The asymmetric factories as `expect` has them, handed in by each side. */
export type Asymmetric = Readonly<Record<string, (...sample: unknown[]) => unknown>>

/** The cases, over the side's own asymmetric factories (`expect.any`, …). */
export function expectCases(a: Asymmetric, not: Asymmetric): readonly ExpectCase[] {
  const wide = (middle: number): Record<string, number> => {
    const out: Record<string, number> = {}
    for (let i = 0; i < 20; i++) out[`key${i}`] = i === 10 ? middle : i
    return out
  }
  const any = (name: string, ...sample: unknown[]) => a[name]?.(...sample)
  return [
    { matcher: 'toBe', received: () => 1, args: () => [1] },
    { matcher: 'toBe', received: () => 1, args: () => [2] },
    { matcher: 'toBe', received: () => 'apple', args: () => ['apples'] },
    { matcher: 'toBe', received: () => ({ a: 1 }), args: () => [{ a: 1 }] },
    { matcher: 'toBe', received: () => ({ a: 1, b: undefined }), args: () => [{ a: 1 }] },
    { matcher: 'toBe', received: () => -0, args: () => [0] },
    { matcher: 'toBe', received: () => 3, args: () => [3], not: true },
    { matcher: 'toEqual', received: () => ({ a: 1, b: 2 }), args: () => [{ a: 1, b: 3 }] },
    { matcher: 'toEqual', received: () => [1, 2, 3], args: () => [[1, 2, 4]] },
    { matcher: 'toEqual', received: () => wide(10), args: () => [wide(99)] },
    { matcher: 'toEqual', received: () => new Map([[1, 'a']]), args: () => [new Map([[1, 'b']])] },
    { matcher: 'toEqual', received: () => new Set([1]), args: () => [new Set([2])] },
    { matcher: 'toEqual', received: () => new Point(1, 2), args: () => [{ x: 1, y: 2 }] },
    { matcher: 'toEqual', received: () => ({ n: 3 }), args: () => [{ n: any('any', Number) }] },
    { matcher: 'toEqual', received: () => ({ n: 'x' }), args: () => [{ n: any('any', Number) }] },
    { matcher: 'toEqual', received: () => 'abc', args: () => [any('stringContaining', 'z')] },
    { matcher: 'toEqual', received: () => 'abc', args: () => [not.stringContaining?.('a')] },
    { matcher: 'toEqual', received: () => [1, 2], args: () => [any('arrayContaining', [3])] },
    {
      matcher: 'toEqual',
      received: () => ({ a: 1 }),
      args: () => [any('objectContaining', { b: 2 })],
    },
    { matcher: 'toEqual', received: () => 'abc', args: () => [any('stringMatching', /z/)] },
    { matcher: 'toEqual', received: () => 1.5, args: () => [any('closeTo', 2, 1)] },
    { matcher: 'toEqual', received: () => null, args: () => [any('anything')] },
    { matcher: 'toEqual', received: () => ({ a: 1 }), args: () => [{ a: 1 }], not: true },
    { matcher: 'toStrictEqual', received: () => ({ a: undefined }), args: () => [{}] },
    { matcher: 'toStrictEqual', received: () => new Point(1, 2), args: () => [{ x: 1, y: 2 }] },
    // biome-ignore lint/suspicious/noSparseArray: a hole, which toStrictEqual tells from undefined
    { matcher: 'toStrictEqual', received: () => [, 1], args: () => [[undefined, 1]] },
    { matcher: 'toMatchObject', received: () => ({ a: 1, b: 2, c: 3 }), args: () => [{ a: 2 }] },
    { matcher: 'toMatchObject', received: () => [{ a: 1 }], args: () => [[{ a: 2 }]] },
    { matcher: 'toMatch', received: () => 'hello', args: () => [/bye/] },
    { matcher: 'toMatch', received: () => 'hello', args: () => ['ell'], not: true },
    { matcher: 'toContain', received: () => [1, 2], args: () => [3] },
    { matcher: 'toContain', received: () => 'abc', args: () => ['z'] },
    { matcher: 'toContain', received: () => [1, 2], args: () => [2], not: true },
    { matcher: 'toContainEqual', received: () => [{ a: 1 }], args: () => [{ a: 2 }] },
    { matcher: 'toBeTruthy', received: () => 0 },
    { matcher: 'toBeFalsy', received: () => 'x' },
    { matcher: 'toBeGreaterThan', received: () => 1, args: () => [2] },
    { matcher: 'toBeGreaterThanOrEqual', received: () => 1, args: () => [2] },
    { matcher: 'toBeLessThan', received: () => 2, args: () => [1] },
    { matcher: 'toBeLessThanOrEqual', received: () => 2n, args: () => [1n] },
    { matcher: 'toBeNaN', received: () => 1 },
    { matcher: 'toBeUndefined', received: () => null },
    { matcher: 'toBeNull', received: () => undefined },
    { matcher: 'toBeNullable', received: () => 0 },
    { matcher: 'toBeDefined', received: () => undefined },
    { matcher: 'toBeTypeOf', received: () => 1, args: () => ['string'] },
    { matcher: 'toBeInstanceOf', received: () => ({}), args: () => [Point] },
    { matcher: 'toBeInstanceOf', received: () => new Point(1, 1), args: () => [Point] },
    { matcher: 'toHaveLength', received: () => [1], args: () => [2] },
    { matcher: 'toHaveLength', received: () => 'ab', args: () => [2], not: true },
    { matcher: 'toHaveProperty', received: () => ({ a: { b: 1 } }), args: () => ['a.c'] },
    { matcher: 'toHaveProperty', received: () => ({ a: { b: 1 } }), args: () => ['a.b', 2] },
    { matcher: 'toHaveProperty', received: () => ({ a: [1] }), args: () => [['a', 0], 1] },
    { matcher: 'toBeCloseTo', received: () => 0.1 + 0.2, args: () => [0.4] },
    { matcher: 'toBeCloseTo', received: () => 0.1 + 0.2, args: () => [0.3], not: true },
    {
      matcher: 'toThrow',
      received: () => () => {
        throw new Error('nope')
      },
      args: () => ['yes'],
    },
    { matcher: 'toThrow', received: () => () => undefined },
    {
      matcher: 'toThrow',
      received: () => () => {
        throw new TypeError('bad')
      },
      args: () => [RangeError],
    },
    {
      matcher: 'toThrowError',
      received: () => () => {
        throw new Error('nope')
      },
      args: () => [/no/],
      not: true,
    },
    {
      matcher: 'toThrow',
      received: () => () => {
        throw new Error('nope')
      },
      args: () => [new Error('yes')],
    },
    { matcher: 'toSatisfy', received: () => 1, args: () => [(n: number) => n > 2] },
    // B25b review: a sync matcher returns the assertion, so a chain goes on from it.
    script('toBe.to.equal (passes)', ({ expect }) => expect(1).toBe(1).to.equal(1)),
    script('toBe.to.equal (fails)', ({ expect }) => expect(1).toBe(1).to.equal(2)),
    // B25b review: after a Chai chain is read, `.rejects.toThrow` still unwraps once.
    script('chain, then rejects.toThrow', ({ expect }) => {
      expect(1).to.equal(1)
      return expect(Promise.reject(new Error('boom'))).rejects.toThrow('boom')
    }),
    script('chain, then rejects.toThrowError(/re/)', ({ expect }) => {
      expect(1).to.equal(1)
      return expect(Promise.reject(new Error('boom'))).rejects.toThrowError(/bo/)
    }),
    script('chain, then rejects.toThrow()', ({ expect }) => {
      expect(1).to.equal(1)
      return expect(Promise.reject(new Error('boom'))).rejects.toThrow()
    }),
    script('rejects.toThrow a message not in it', ({ expect }) =>
      expect(Promise.reject(new Error('boom'))).rejects.toThrow('nope'),
    ),
    // B25b review: a wrong settlement is Chai's AssertionError, with its diff or its cause.
    script('resolves on a rejection', ({ expect }) =>
      expect(Promise.reject(new Error('x'))).resolves.toBe(1),
    ),
    script('rejects on a resolution', ({ expect }) => expect(Promise.resolve(5)).rejects.toBe(1)),
    // B25b review: a custom matcher's `this` is Vitest's (its `equals`, `soft`, `poll`).
    script('custom matcher this.equals of errors that differ in cause', ({ expect, extend }) => {
      extend({
        toEqualByThisEquals(this: CaseContext, received: unknown, expected: unknown) {
          return { pass: this.equals(received, expected), message: () => 'not equal' }
        },
      })
      return expect(new Error('a', { cause: 1 })).toEqualByThisEquals(new Error('a', { cause: 2 }))
    }),
    script("a custom matcher's context", ({ expect, extend }) => {
      extend({
        toShowContext(this: CaseContext) {
          const seen = {
            soft: this.soft ?? null,
            poll: this.poll ?? null,
            promise: this.promise,
          }
          return { pass: false, message: () => JSON.stringify(seen) }
        },
      })
      return expect(1).toShowContext()
    }),
    // B25b review: the realm-safe class tests keep a same-realm value's verdict.
    script('toMatchObject over an object tagged Date', ({ expect }) =>
      expect({ x: { a: 1, [tag]: 'Date' } }).toMatchObject({ x: { a: 1 } }),
    ),
    script('toMatchObject over an object tagged Date (fails)', ({ expect }) =>
      expect({ x: { a: 1, [tag]: 'Date' } }).toMatchObject({ x: { a: 2 } }),
    ),
    script('toStrictEqual of objects tagged ArrayBuffer', ({ expect }) =>
      expect({ a: 1, [tag]: 'ArrayBuffer' }).toStrictEqual({ a: 2, [tag]: 'ArrayBuffer' }),
    ),
    script('toThrow with an object tagged RegExp', ({ expect }) =>
      expect(() => {
        throw new Error('x')
      }).toThrow({ message: 'y', [tag]: 'RegExp' }),
    ),
    script('toEqual of a Map subclass with its own tag', ({ expect }) => {
      class Tagged extends Map<number, number> {
        get [tag](): string {
          return 'Other'
        }
      }
      return expect(new Tagged([[1, 2]])).toEqual(new Tagged([[1, 3]]))
    }),
    // Chai's own chains (D170: Chai loads when one is read).
    { matcher: 'to.equal', received: () => 1, args: () => [1] },
    { matcher: 'to.equal', received: () => 1, args: () => [2] },
    { matcher: 'to.deep.equal', received: () => ({ a: [1] }), args: () => [{ a: [2] }] },
    { matcher: 'to.be.a', received: () => 'x', args: () => ['number'] },
    { matcher: 'to.include', received: () => [1, 2], args: () => [2], not: true },
    { matcher: 'to.toBe', received: () => 1, args: () => [2] },
    { matcher: 'toBeFoo', received: () => 1 },
    { matcher: 'toBeOneOf', received: () => 4, args: () => [[1, 2, 3]] },
  ]
}
