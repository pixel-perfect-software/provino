// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const real = { setTimeout, Date }

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

const STACK = '\nStack Trace:\n'
const cut = (text: string) => text.split(STACK)[0]
const hasStackSection = (text: string) => text.includes(STACK)

/** What a call did: what it returned, threw, and what it passed to `console.warn`. */
const capture = async (run: () => unknown) => {
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(' '))
  }
  try {
    const returned = await run()
    return {
      threw: 'did not throw',
      returned: returned === M ? 'facade' : returned === undefined ? 'undefined' : typeof returned,
      warned: warned.map(cut),
      stackSection: warned.map(hasStackSection),
    }
  } catch (error) {
    const text = (error as Error).message
    return { threw: cut(text), warned: warned.map(cut), stackSection: [hasStackSection(text)] }
  } finally {
    console.warn = warn
  }
}

c('advanceTimersByTime while the timers are real', () => capture(() => M.advanceTimersByTime(10)))

c('every call that needs fake timers, made while they are real', async () => {
  const seen: Record<string, unknown> = {}
  for (const name of [
    'runAllTimers',
    'runOnlyPendingTimers',
    'advanceTimersToNextTimer',
    'advanceTimersToNextFrame',
    'runAllTicks',
    'getTimerCount',
    'clearAllTimers',
  ]) {
    seen[name] = await capture(() => M[name]())
  }
  return seen
})

c('the async calls, made while the timers are real', async () => {
  const seen: Record<string, unknown> = {}
  for (const name of [
    'advanceTimersByTimeAsync',
    'runAllTimersAsync',
    'runOnlyPendingTimersAsync',
    'advanceTimersToNextTimerAsync',
  ]) {
    seen[name] = await capture(() => M[name](10))
  }
  return seen
})

c('setSystemTime while the timers are real', async () => {
  const before = Date.now()
  const result = await capture(() => M.setSystemTime(0))
  return { ...result, dateIsFake: Date !== real.Date, dateNowMovedBack: Date.now() < before }
})

c('setSystemTime while the timers are real, called again, then useRealTimers', async () => {
  await capture(() => M.setSystemTime(1_000_000))
  const second = await capture(() => M.setSystemTime(2_000_000))
  const dateNowIsTheSecondTime = Date.now() === 2_000_000
  const timersStayReal = setTimeout === real.setTimeout
  M.useRealTimers()
  return {
    second: second.threw,
    dateNowIsTheSecondTime,
    timersStayReal,
    dateRealAgain: Date === real.Date,
  }
})

c('useFakeTimers after a Date-only setSystemTime keeps that time', async () => {
  await capture(() => M.setSystemTime(3_000_000))
  M.useFakeTimers()
  const startsAtThatTime = Date.now() === 3_000_000
  const before = Date.now()
  M.advanceTimersByTime(10)
  return {
    startsAtThatTime,
    advancedBy: Date.now() - before,
    timersFaked: setTimeout !== real.setTimeout,
  }
})
