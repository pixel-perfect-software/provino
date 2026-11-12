/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "http://example.test/page?q=1"}
 */
test('the options docblock sets the url', () => {
  expect(location.href).toBe('http://example.test/page?q=1')
  expect(location.search).toBe('?q=1')
})
test('and the DOM is jsdom', () => {
  expect(typeof document).toBe('object')
})
