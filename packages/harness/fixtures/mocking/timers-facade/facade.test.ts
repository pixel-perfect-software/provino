// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const isJest = typeof jest !== 'undefined'

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function'

/** What a returned value is: the facade, nothing, a promise of either, or something else. */
const kind = async (value: unknown): Promise<unknown> => {
  if (isThenable(value)) return { promise: await kind(await value) }
  if (value === M) return 'facade'
  if (value === undefined) return 'undefined'
  return typeof value
}

const tickMode = isJest ? { mode: 'manual' } : 'manual'

c('what the members that switch timers on and off return', async () => {
  const seen: Record<string, unknown> = {}
  seen.useFakeTimers = await kind(M.useFakeTimers())
  seen.setTimerTickMode = await kind(M.setTimerTickMode(tickMode))
  seen.useRealTimers = await kind(M.useRealTimers())
  return seen
})

c('what the members that move the clock return', async () => {
  M.useFakeTimers()
  const seen: Record<string, unknown> = {}
  seen.advanceTimersByTime = await kind(M.advanceTimersByTime(1))
  seen.advanceTimersToNextTimer = await kind(M.advanceTimersToNextTimer())
  seen.advanceTimersToNextFrame = await kind(M.advanceTimersToNextFrame())
  seen.runAllTimers = await kind(M.runAllTimers())
  seen.runOnlyPendingTimers = await kind(M.runOnlyPendingTimers())
  seen.runAllTicks = await kind(M.runAllTicks())
  seen.clearAllTimers = await kind(M.clearAllTimers())
  seen.setSystemTime = await kind(M.setSystemTime(0))
  return seen
})

c('what the async members return', async () => {
  M.useFakeTimers()
  const seen: Record<string, unknown> = {}
  seen.advanceTimersByTimeAsync = await kind(M.advanceTimersByTimeAsync(1))
  seen.advanceTimersToNextTimerAsync = await kind(M.advanceTimersToNextTimerAsync())
  seen.runAllTimersAsync = await kind(M.runAllTimersAsync())
  seen.runOnlyPendingTimersAsync = await kind(M.runOnlyPendingTimersAsync())
  return seen
})

c('what the members that answer return', () => {
  M.useFakeTimers({ now: 5000 })
  return {
    getTimerCount: M.getTimerCount(),
    getRealSystemTime: typeof M.getRealSystemTime(),
  }
})

c('the timer members each runner has', () => {
  const names = [
    'useFakeTimers',
    'useRealTimers',
    'runAllTimers',
    'runAllTimersAsync',
    'runOnlyPendingTimers',
    'runOnlyPendingTimersAsync',
    'advanceTimersByTime',
    'advanceTimersByTimeAsync',
    'advanceTimersToNextTimer',
    'advanceTimersToNextTimerAsync',
    'advanceTimersToNextFrame',
    'runAllTicks',
    'clearAllTimers',
    'getTimerCount',
    'now',
    'isFakeTimers',
    'setSystemTime',
    'getMockedSystemTime',
    'getRealSystemTime',
    'setTimerTickMode',
    'runAllImmediates',
  ]
  return names.filter((name) => typeof M[name] === 'function')
})
