import { el, half } from 'rn-like'

test('the package Node cannot parse loads through the transform', () => {
  expect(el.tag).toBe('b')
  expect(half(4)).toBe(2)
})
