// One check per test: a status in the golden is Jest's verdict on it.
test('the timers are real until a test installs them', () => {
  expect('clock' in setTimeout).toBe(false)
  expect(Date.now()).toBeGreaterThan(1_000_000)
})
test('useFakeTimers starts at the configured now', () => {
  jest.useFakeTimers()
  expect(Date.now()).toBe(5000)
})
test('a call own now wins over the configured one', () => {
  jest.useFakeTimers({ now: 9000 })
  expect(Date.now()).toBe(9000)
})
test('the configured timerLimit applies to an install that names none', () => {
  jest.useFakeTimers()
  setInterval(() => {}, 10)
  expect(() => jest.runAllTimers()).toThrow(/Aborting after running 50 timers/)
})
test('a call own timerLimit wins', () => {
  jest.useFakeTimers({ timerLimit: 7 })
  setInterval(() => {}, 10)
  expect(() => jest.runAllTimers()).toThrow(/Aborting after running 7 timers/)
})
