// Fake timers through the runner's own object. Each case puts the real timers back.
type Timers = {
  useFakeTimers(options?: unknown): unknown
  useRealTimers(): unknown
  runAllTimers(): unknown
  advanceTimersByTime(ms: number): unknown
  advanceTimersToNextTimer(steps?: number): unknown
  setSystemTime(now: number): unknown
}
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const real = { nextTick: process.nextTick, queueMicrotask, setTimeout, setInterval }

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

const warnings = (run: () => unknown): { threw: unknown; warned: string[] } => {
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(' '))
  }
  try {
    run()
    return { threw: 'did not throw', warned }
  } catch (error) {
    return { threw: error, warned }
  } finally {
    console.warn = warn
  }
}

// A fake `setTimeout` carries its clock (@sinonjs/fake-timers) or is a mock (Jest's legacy timers).
const isFaked = (fn: unknown): boolean =>
  typeof fn === 'function' &&
  ('clock' in fn || (fn as { _isMockFunction?: boolean })._isMockFunction === true)

c('timers.enableGlobally', () => isFaked(setTimeout))

c('timers.toFakeDefault', () => {
  M.useFakeTimers()
  const faked = {
    nextTick: process.nextTick !== real.nextTick,
    queueMicrotask: globalThis.queueMicrotask !== real.queueMicrotask,
  }
  if (faked.nextTick && faked.queueMicrotask) return 'all'
  if (!faked.nextTick && !faked.queueMicrotask) return 'all-but-microtasks'
  return faked
})

c('timers.loopLimit', () => {
  M.useFakeTimers()
  const loop = () => setTimeout(loop, 1)
  loop()
  try {
    M.runAllTimers()
    return 'no limit'
  } catch (error) {
    const match = /after running (\d+) timers/.exec(String((error as Error).message))
    return match === null ? String((error as Error).message) : Number(match[1])
  }
})

c('timers.legacyAvailable', () => {
  M.useFakeTimers({ legacyFakeTimers: true })
  return (setTimeout as unknown as { _isMockFunction?: boolean })._isMockFunction === true
})

c('timers.optionNames', () => {
  M.useFakeTimers({ doNotFake: ['setInterval'] })
  const doNotFake = setInterval === real.setInterval && setTimeout !== real.setTimeout
  M.useRealTimers()
  M.useFakeTimers({ toFake: ['setTimeout'] })
  const toFake = setInterval === real.setInterval && setTimeout !== real.setTimeout
  if (doNotFake && !toFake) return 'do-not-fake'
  if (toFake && !doNotFake) return 'to-fake'
  return { doNotFake, toFake }
})

c('timers.notFaked', () => {
  const { threw, warned } = warnings(() => M.advanceTimersByTime(1))
  if (threw === 'did not throw' && warned.length > 0) return 'warn'
  if (threw !== 'did not throw' && warned.length === 0) return 'throw'
  return { threw, warned }
})

c('timers.setSystemTimeWithoutFakes', () => {
  const before = Date.now()
  const { threw, warned } = warnings(() => M.setSystemTime(0))
  const now = Date.now()
  if (threw === 'did not throw' && warned.length > 0 && now >= before) return 'warn-noop'
  if (threw === 'did not throw' && warned.length === 0 && now < before) return 'fake-date-only'
  return { threw, warned, movedBack: now < before }
})

c('timers.advanceToNextTimerHonorsSteps', () => {
  M.useFakeTimers()
  const fired: number[] = []
  for (const ms of [10, 20, 30]) setTimeout(() => fired.push(ms), ms)
  M.advanceTimersToNextTimer(2)
  if (fired.length === 2) return true
  if (fired.length === 1) return false
  return fired
})

// `timers.facadeReturns` (what each member returns) is recorded by `mocking/timers-facade` (B17a).
