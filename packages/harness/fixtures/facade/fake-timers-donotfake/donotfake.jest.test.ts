// One check per test: a status in the golden is Jest's verdict on it.
test('setTimeout is faked', () => {
  expect('clock' in setTimeout).toBe(true)
})
test('Date stays real while the clock advances', () => {
  const before = Date.now()
  jest.advanceTimersByTime(60_000)
  expect(Date.now() - before).toBeLessThan(5000)
})
test('a call that names no config keeps the project defaults', () => {
  jest.useFakeTimers()
  expect('clock' in setTimeout).toBe(true)
  const before = Date.now()
  jest.advanceTimersByTime(60_000)
  expect(Date.now() - before).toBeLessThan(5000)
})
test('a call that names doNotFake replaces the project list', () => {
  jest.useFakeTimers({ doNotFake: [] })
  const before = Date.now()
  jest.advanceTimersByTime(60_000)
  expect(Date.now() - before).toBe(60_000)
})
