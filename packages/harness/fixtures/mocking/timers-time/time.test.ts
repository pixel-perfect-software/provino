// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const isJest = typeof jest !== 'undefined'
const real = { Date }

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

c('Date.now(), new Date() and Date.parse follow the fake clock', () => {
  M.useFakeTimers({ now: new Date('2024-02-03T04:05:06.000Z') })
  const start = Date.now()
  M.advanceTimersByTime(1500)
  return {
    start,
    nowAfter: Date.now(),
    newDate: new Date().toISOString(),
    isFake: (Date as unknown as { isFake?: boolean }).isFake === true,
    instanceOfRealDate: new Date() instanceof real.Date,
  }
})

c('performance.now() and process.hrtime() follow the fake clock', () => {
  M.useFakeTimers({ now: 0 })
  const perf = performance.now()
  const hr = process.hrtime()
  M.advanceTimersByTime(2500)
  const hrAfter = process.hrtime(hr)
  return { perfAfter: performance.now() - perf, hrAfter, hrBigint: process.hrtime.bigint() > 0n }
})

c('getRealSystemTime stays real while the clock is faked', () => {
  M.useFakeTimers({ now: 0 })
  M.advanceTimersByTime(1000)
  const realTime = M.getRealSystemTime() as number
  return {
    nearTheRealTime: Math.abs(realTime - real.Date.now()) < 5000,
    farFromTheFakeTime: Math.abs(realTime - Date.now()) > 1000,
  }
})

c('setSystemTime takes a number or a Date, and moves the clock without firing timers', () => {
  M.useFakeTimers({ now: 0 })
  let fired = 0
  setTimeout(() => {
    fired++
  }, 10)
  M.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
  const afterDate = Date.now()
  M.setSystemTime(99)
  return { afterDate, afterNumber: Date.now(), firedAtSet: fired }
})

c('the runner`s own way to read the clock', () => {
  if (isJest) {
    const before = M.now() as number
    const realBefore = Math.abs(before - real.Date.now()) < 5000
    M.useFakeTimers({ now: 4000 })
    const during = M.now()
    M.advanceTimersByTime(100)
    return { realBefore, during, afterAdvance: M.now() }
  }
  const isFakeBefore = M.isFakeTimers()
  const mockedBefore = M.getMockedSystemTime()
  M.useFakeTimers({ now: 4000 })
  const isFakeDuring = M.isFakeTimers()
  const mockedDuring = M.getMockedSystemTime()
  M.advanceTimersByTime(100)
  const mockedAfter = M.getMockedSystemTime()
  M.useRealTimers()
  return {
    isFakeBefore,
    mockedBefore,
    isFakeDuring,
    mockedDuring,
    mockedAfter,
    isFakeEnd: M.isFakeTimers(),
  }
})
