import { discount, price, total } from '../src/pricing.ts'

describe('pricing', () => {
  test('prices with the default unit', () => {
    expect(price(3)).toBe(6)
  })

  test('refuses a negative quantity', () => {
    expect(() => price(-1)).toThrow('negative quantity')
  })

  test('discounts a large total', () => {
    expect(discount(200)).toBe(180)
  })

  test('adds up the lines', () => {
    expect(
      total([
        { sku: 'a', quantity: 2, unit: 5 },
        { sku: 'b', quantity: 1 },
      ]),
    ).toBe(12)
  })
})
