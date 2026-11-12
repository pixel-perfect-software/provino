/**
 * @jest-environment node
 */
test('the docblock picks the node environment for this file', () => {
  expect(typeof document).toBe('undefined')
  expect(typeof window).toBe('undefined')
})
