/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://example.test/file"}
 */
test('the URL is the docblock option', () => {
  expect(location.href).toBe('http://example.test/file')
})

test('the project user agent is not merged in', () => {
  expect(navigator.userAgent).toMatch(/jsdom/)
})
