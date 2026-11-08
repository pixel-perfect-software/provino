// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers
// The native `Temporal`, and whatever the global holds now (fake timers replace the global).
// biome-ignore lint/suspicious/noExplicitAny: Temporal has no types on this Node
const native = (globalThis as unknown as { Temporal?: any }).Temporal
// biome-ignore lint/suspicious/noExplicitAny: Temporal has no types on this Node
const current = () => (globalThis as unknown as { Temporal: any }).Temporal
const isFaked = () => current() !== native

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

c('Temporal exists on this Node', () => ({ typeofTemporal: typeof native }))

c('useFakeTimers() with no options fakes Temporal, and Temporal.Now follows the clock', () => {
  M.useFakeTimers({ now: 5000 })
  const during = {
    faked: isFaked(),
    instant: current().Now.instant().epochMilliseconds,
  }
  M.advanceTimersByTime(250)
  return { ...during, afterAdvance: current().Now.instant().epochMilliseconds }
})

c('doNotFake and toNotFake leave Temporal real', () => {
  const seen: Record<string, unknown> = {}
  M.useFakeTimers({ doNotFake: ['Temporal'] })
  seen['doNotFake: [Temporal]'] = !isFaked()
  M.useRealTimers()
  M.useFakeTimers({ toNotFake: ['Temporal'] })
  seen['toNotFake: [Temporal]'] = !isFaked()
  M.useRealTimers()
  return seen
})

c('setSystemTime while the timers are real and Temporal', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    M.setSystemTime(2_000_000)
  } finally {
    console.warn = warn
  }
  const faked = isFaked()
  return { temporalFaked: faked, instant: faked ? current().Now.instant().epochMilliseconds : null }
})
