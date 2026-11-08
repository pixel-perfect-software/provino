// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const real = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  nextTick: process.nextTick,
  hrtime: process.hrtime,
  queueMicrotask,
  Date,
  performance,
  Intl,
}
const sleep = (ms: number) => new Promise<void>((resolve) => real.setTimeout(resolve, ms))

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

c('useFakeTimers() with no options: which globals are faked', () => {
  M.useFakeTimers()
  return {
    setTimeout: setTimeout !== real.setTimeout,
    clearTimeout: clearTimeout !== real.clearTimeout,
    setInterval: setInterval !== real.setInterval,
    clearInterval: clearInterval !== real.clearInterval,
    setImmediate: setImmediate !== real.setImmediate,
    clearImmediate: clearImmediate !== real.clearImmediate,
    Date: Date !== real.Date,
    nextTick: process.nextTick !== real.nextTick,
    queueMicrotask: globalThis.queueMicrotask !== real.queueMicrotask,
    hrtime: process.hrtime !== real.hrtime,
    performance: performance !== real.performance,
    Intl: Intl !== real.Intl,
  }
})

c('the fake clock starts at the real time and moves only when told', async () => {
  M.useFakeTimers()
  const start = Date.now()
  const startsNearReal = Math.abs(start - real.Date.now()) < 5000
  const first = Date.now()
  await sleep(20)
  const second = Date.now()
  M.advanceTimersByTime(25)
  return { startsNearReal, frozenBetweenReads: first === second, advancedBy: Date.now() - second }
})

c('timers fire in due order, and a timer set by a callback joins the queue', () => {
  M.useFakeTimers()
  const log: string[] = []
  setTimeout(() => {
    log.push('t10')
    setTimeout(() => log.push('t10+5'), 5)
  }, 10)
  setTimeout(() => log.push('t5'), 5)
  setTimeout(() => log.push('t12'), 12)
  setTimeout(() => log.push('t20'), 20)
  M.advanceTimersByTime(14)
  const afterFourteen = [...log]
  M.advanceTimersByTime(100)
  return { afterFourteen, afterAll: log }
})

c('an interval fires once per period and stops when cleared', () => {
  M.useFakeTimers()
  let ticks = 0
  const id = setInterval(() => {
    ticks++
  }, 10)
  M.advanceTimersByTime(35)
  const beforeClear = ticks
  clearInterval(id)
  M.advanceTimersByTime(100)
  return { beforeClear, afterClear: ticks }
})

c('setTimeout with no delay and setImmediate fire on the next advance, in order', () => {
  M.useFakeTimers()
  const log: string[] = []
  setTimeout(() => log.push('timeout 0'), 0)
  setImmediate(() => log.push('immediate'))
  setTimeout(() => log.push('timeout 1'), 1)
  M.advanceTimersByTime(0)
  const atZero = [...log]
  M.advanceTimersByTime(1)
  return { atZero, afterOne: log }
})
