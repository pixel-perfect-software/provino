/**
 * @jest-environment node
 */
// The smallest file, so it runs last, with no window: the others' scheduler slices would come due
// here, where nothing defines `window`.
beforeAll(() => new Promise((resolve) => setTimeout(resolve, 400)))

test('wait: runs after the other files, with no window', () => {
  expect(typeof window).toBe('undefined')
})
