import { Cart } from '../src/cart.ts'

describe('cart', () => {
  test('merges lines of the same sku', () => {
    const cart = new Cart('ada').add({ sku: 'a', quantity: 1 }).add({ sku: 'a', quantity: 2 })
    expect(cart.size).toBe(1)
    expect(cart.owner).toBe('ada')
  })

  test('checks out with a half-price coupon', () => {
    const cart = new Cart().add({ sku: 'a', quantity: 4 })
    cart.coupon = 'HALF-OFF'
    expect(cart.checkout()).toBe(4)
  })

  test('keeps the first coupon', () => {
    const cart = new Cart()
    cart.coupon = 'FIRST'
    cart.coupon = 'SECOND'
    expect(cart.coupon).toBe('FIRST')
  })

  test('counts the carts it made', () => {
    expect(Cart.created).toBeGreaterThan(0)
  })
})
