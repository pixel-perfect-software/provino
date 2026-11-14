import { firstNegative, label, money } from '../src/format.ts'

describe('format', () => {
  test('formats euros by default', () => {
    expect(money(2)).toBe('€2.00')
  })

  test('formats yen without decimals', () => {
    expect(money(5, 'JPY')).toBe('JPY5')
  })

  test('finds the first negative cell', () => {
    expect(
      firstNegative([
        [1, 2],
        [3, -4],
      ]),
    ).toEqual([1, 1])
  })

  test('labels a positive number', () => {
    expect(label(3)).toBe('positive')
  })
})
