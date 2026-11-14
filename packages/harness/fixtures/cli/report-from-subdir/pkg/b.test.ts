// A failing file, so the run's header says FAIL for it and the exit code is 1.
test('b fails', () => {
  expect(1).toBe(2)
})
