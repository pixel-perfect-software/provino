// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
const real = { setTimeout, setInterval, nextTick: process.nextTick, Date }
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

/** Which of three globals are faked now. */
const faked = () => ({
  setTimeout: setTimeout !== real.setTimeout,
  setInterval: setInterval !== real.setInterval,
  Date: Date !== real.Date,
})

c('the option that leaves a global real, in each runner`s names', () => {
  const seen: Record<string, unknown> = {}
  M.useFakeTimers({ doNotFake: ['setInterval'] })
  seen['doNotFake: [setInterval]'] = faked()
  M.useRealTimers()
  M.useFakeTimers({ toNotFake: ['setInterval'] })
  seen['toNotFake: [setInterval]'] = faked()
  M.useRealTimers()
  M.useFakeTimers({ toFake: ['setTimeout'] })
  seen['toFake: [setTimeout]'] = faked()
  M.useRealTimers()
  return seen
})

// (`toFake: ['nextTick']` is left out: Vitest refuses it in a child process, which its default pool is.)
c('doNotFake or toNotFake naming nextTick and queueMicrotask, and the default for them', () => {
  const seen: Record<string, unknown> = {}
  const microtasks = () => ({
    nextTick: process.nextTick !== real.nextTick,
    queueMicrotask: globalThis.queueMicrotask !== queueMicrotaskBefore,
  })
  const queueMicrotaskBefore = globalThis.queueMicrotask
  M.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] })
  seen.doNotFake = microtasks()
  M.useRealTimers()
  M.useFakeTimers({ toNotFake: ['setInterval'] })
  seen.toNotFake = microtasks()
  M.useRealTimers()
  return seen
})

c('runAllTimers on an endless loop gives up after the default limit', () => {
  M.useFakeTimers()
  const loop = () => setTimeout(loop, 1)
  loop()
  try {
    M.runAllTimers()
    return 'no limit'
  } catch (error) {
    return (error as Error).message
  }
})

c('the loop limit option, in each runner`s names', () => {
  const seen: Record<string, unknown> = {}
  const gives = (options: unknown) => {
    M.useFakeTimers(options)
    const loop = () => setTimeout(loop, 1)
    loop()
    try {
      M.runAllTimers()
      return 'no limit'
    } catch (error) {
      return (error as Error).message
    } finally {
      M.useRealTimers()
    }
  }
  seen['timerLimit: 7'] = gives({ timerLimit: 7 })
  seen['loopLimit: 9'] = gives({ loopLimit: 9 })
  return seen
})

c('advancing with real time, in each runner`s names', async () => {
  const seen: Record<string, unknown> = {}
  const advancedAfterSleep = async (options: unknown) => {
    M.useFakeTimers(options)
    const before = Date.now()
    await sleep(120)
    const moved = Date.now() - before
    M.useRealTimers()
    return moved >= 20
  }
  seen['no option'] = await advancedAfterSleep(undefined)
  seen['advanceTimers: true'] = await advancedAfterSleep({ advanceTimers: true })
  seen['advanceTimers: 10'] = await advancedAfterSleep({ advanceTimers: 10 })
  seen['shouldAdvanceTime: true'] = await advancedAfterSleep({ shouldAdvanceTime: true })
  seen['shouldAdvanceTime with advanceTimeDelta: 10'] = await advancedAfterSleep({
    shouldAdvanceTime: true,
    advanceTimeDelta: 10,
  })
  return seen
})

c('a fake clearTimeout clears a timer that was made before the fakes', async () => {
  let fired = false
  const nativeId = real.setTimeout(() => {
    fired = true
  }, 30)
  M.useFakeTimers()
  clearTimeout(nativeId)
  M.useRealTimers()
  await sleep(80)
  return { nativeTimerFired: fired }
})

c('now: the start time option', () => {
  M.useFakeTimers({ now: 1_000_000 })
  const start = Date.now()
  M.advanceTimersByTime(500)
  return { start, afterAdvance: Date.now() }
})
