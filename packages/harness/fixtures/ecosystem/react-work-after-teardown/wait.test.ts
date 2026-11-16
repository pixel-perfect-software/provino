// The smallest file, so it runs last: the others' timers come due here.
beforeAll(() => new Promise((resolve) => setTimeout(resolve, 400)))

test('wait: runs after the other files', () => {
  expect(document.body.innerHTML).toBe('')
})
