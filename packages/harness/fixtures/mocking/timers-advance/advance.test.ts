// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const real = { setTimeout, nextTick: process.nextTick, Date }

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

c('advanceTimersToNextTimer(2) with three timers pending', () => {
  M.useFakeTimers()
  const fired: number[] = []
  for (const ms of [10, 20, 30]) setTimeout(() => fired.push(ms), ms)
  M.advanceTimersToNextTimer(2)
  const afterTwo = [...fired]
  M.advanceTimersToNextTimer()
  return { afterTwo, afterOneMore: fired }
})

c('advanceTimersToNextTimer fires the timers due at the same instant together', () => {
  M.useFakeTimers()
  const fired: string[] = []
  setTimeout(() => fired.push('a'), 10)
  setTimeout(() => fired.push('b'), 10)
  setTimeout(() => fired.push('c'), 20)
  M.advanceTimersToNextTimer()
  return { fired, count: M.getTimerCount() }
})

c('advanceTimersToNextFrame moves to the next 16 ms frame', () => {
  M.useFakeTimers({ now: 0 })
  M.advanceTimersByTime(5)
  M.advanceTimersToNextFrame()
  const first = Date.now()
  M.advanceTimersToNextFrame()
  return { first, second: Date.now() }
})

c('the async advance flushes promise jobs between timers', async () => {
  M.useFakeTimers()
  const log: string[] = []
  setTimeout(() => {
    log.push('timer 1')
    void Promise.resolve().then(() => log.push('job after 1'))
  }, 10)
  setTimeout(() => log.push('timer 2'), 20)
  await M.advanceTimersByTimeAsync(20)
  return log
})

c('the sync advance does not flush promise jobs between timers', async () => {
  M.useFakeTimers()
  const log: string[] = []
  setTimeout(() => {
    log.push('timer 1')
    void Promise.resolve().then(() => log.push('job after 1'))
  }, 10)
  setTimeout(() => log.push('timer 2'), 20)
  M.advanceTimersByTime(20)
  const atReturn = [...log]
  await Promise.resolve()
  return { atReturn, afterMicrotask: log }
})

c('runAllTimersAsync and runOnlyPendingTimersAsync flush promise jobs', async () => {
  M.useFakeTimers()
  const log: string[] = []
  setTimeout(() => {
    log.push('timer 1')
    void Promise.resolve().then(() => setTimeout(() => log.push('timer 3'), 5))
  }, 10)
  setTimeout(() => log.push('timer 2'), 20)
  await M.runOnlyPendingTimersAsync()
  const afterPending = [...log]
  await M.runAllTimersAsync()
  return { afterPending, afterAll: log }
})

c('runAllTicks runs a nextTick callback at once only where nextTick is faked', () => {
  M.useFakeTimers()
  let ran = false
  process.nextTick(() => {
    ran = true
  })
  M.runAllTicks()
  return { ranAtOnce: ran }
})

c('runAllTimers runs timers a callback adds; runOnlyPendingTimers does not', () => {
  const seen: Record<string, unknown> = {}
  for (const name of ['runAllTimers', 'runOnlyPendingTimers']) {
    M.useFakeTimers()
    const log: string[] = []
    setTimeout(() => {
      log.push('first')
      setTimeout(() => log.push('added'), 100)
    }, 10)
    setTimeout(() => log.push('second'), 20)
    M[name]()
    seen[name] = { ran: [...log], left: M.getTimerCount() }
    M.useRealTimers()
  }
  return seen
})

c('clearAllTimers and getTimerCount', () => {
  M.useFakeTimers()
  const a = setTimeout(() => {}, 10)
  setTimeout(() => {}, 20)
  setInterval(() => {}, 30)
  const beforeClear = M.getTimerCount()
  clearTimeout(a)
  const afterOneCleared = M.getTimerCount()
  M.clearAllTimers()
  return { beforeClear, afterOneCleared, afterClearAll: M.getTimerCount() }
})

c('setSystemTime under fake timers does not fire pending timers', () => {
  M.useFakeTimers({ now: 0 })
  let fired = false
  setTimeout(() => {
    fired = true
  }, 1000)
  M.setSystemTime(5000)
  const now = Date.now()
  const firedAtSet = fired
  M.advanceTimersByTime(1000)
  return { now, firedAtSet, firedAfterAdvance: fired }
})

c('a second useFakeTimers() drops the pending timers', () => {
  M.useFakeTimers()
  let fired = false
  setTimeout(() => {
    fired = true
  }, 10)
  M.useFakeTimers()
  const countAfter = M.getTimerCount()
  M.advanceTimersByTime(100)
  return { countAfter, fired }
})

c('useRealTimers puts the real globals back', () => {
  M.useFakeTimers()
  M.useRealTimers()
  return {
    setTimeout: setTimeout === real.setTimeout,
    Date: Date === real.Date,
    nextTick: process.nextTick === real.nextTick,
  }
})

c('a callback that throws surfaces from the advance call', () => {
  M.useFakeTimers()
  setTimeout(() => {
    throw new Error('boom from a timer')
  }, 10)
  let message: string | undefined
  try {
    M.advanceTimersByTime(10)
  } catch (error) {
    message = (error as Error).message
  }
  return { message }
})
