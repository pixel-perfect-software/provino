// The larger file, so a runner with no history runs it first.
const { expectTypeOf } = require('expect-type') as typeof import('expect-type')

describe('expectTypeOf on values', () => {
  it('toEqualTypeOf and toMatchTypeOf', () => {
    expectTypeOf({ a: 1 }).toEqualTypeOf<{ a: number }>()
    expectTypeOf({ a: 1, b: 'x' }).toMatchTypeOf<{ a: number }>()
    expectTypeOf('x').not.toEqualTypeOf<number>()
    expect(typeof expectTypeOf).toBe('function')
  })

  it('returns more of the same at run time', () => {
    const chained = expectTypeOf([1, 2]).items
    expectTypeOf(chained).toBeObject()
    expect(chained).toBeDefined()
  })
})
