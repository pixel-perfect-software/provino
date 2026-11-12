// One check per test: a status in the golden is Jest's verdict on it.
test('the timers are faked without a call, so setTimeout has a clock', () => {
  expect('clock' in setTimeout).toBe(true)
})
test('the clock starts at the configured now', () => {
  expect(Date.now()).toBe(123456)
})
test('a timeout fires when the clock is advanced', () => {
  const calls: number[] = []
  setTimeout(() => calls.push(1), 100)
  expect(calls).toEqual([])
  jest.advanceTimersByTime(100)
  expect(calls).toEqual([1])
})
test('runAllTimers gives up after the timer limit', () => {
  setInterval(() => {}, 10)
  expect(() => jest.runAllTimers()).toThrow(
    /Aborting after running 50 timers, assuming an infinite loop!/,
  )
})
test('useRealTimers puts the real ones back', () => {
  jest.useRealTimers()
  expect('clock' in setTimeout).toBe(false)
})
