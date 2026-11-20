/**
 * @vitest-environment jsdom
 */
test('the vitest pragma gives a jsdom window', () => {
  expect(navigator.userAgent).toMatch(/jsdom/)
})
