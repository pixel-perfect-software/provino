/**
 * @jest-environment happy-dom
 */
test('the jest pragma gives a happy-dom window', () => {
  expect(navigator.userAgent).toMatch(/HappyDOM/)
})
