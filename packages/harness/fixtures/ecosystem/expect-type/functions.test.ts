const { expectTypeOf } = require('expect-type') as typeof import('expect-type')

const greet = (name: string, times: number): string => name.repeat(times)

it('reads a parameter and the return type', () => {
  expectTypeOf(greet).parameter(0).toEqualTypeOf<string>()
  expectTypeOf(greet).parameter(1).toBeNumber()
  expectTypeOf(greet).returns.toEqualTypeOf<string>()
  expectTypeOf(greet).toBeCallableWith('a', 2)
  expect(greet('a', 2)).toBe('aa')
})
