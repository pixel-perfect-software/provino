import { both, checked, greet, lazy, parse } from '../src/edge.ts'

describe('edge', () => {
  test('a negative value throws before the return after the failing call', () => {
    expect(() => checked(-1)).toThrow('negative')
  })

  test('greets with the default parameters', () => {
    expect(greet()).toBe('hello world!')
  })

  test('greets a name', () => {
    expect(greet('ada', '.')).toBe('hello ada.')
  })

  test('parses a number', () => {
    expect(parse('4')).toBe(4)
  })

  test('both and one', async () => {
    expect(both(true, true)).toBe('both')
    expect(both(false, true)).toBe('one')
    expect(await lazy(async () => 7)).toBe(7)
  })
})
