// No docblock: the project's environmentOptions.jsdom.
test('the URL is the project option', () => {
  expect(location.href).toBe('http://example.test/base')
})

test('the user agent is the project option', () => {
  expect(navigator.userAgent).toBe('provino-project')
})
