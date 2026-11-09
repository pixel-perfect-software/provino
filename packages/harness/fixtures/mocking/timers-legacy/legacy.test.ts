// Fake timers through the runner's own object (`jest` or `vi`). Each case puts the real timers back.
type Timers = Record<string, (...args: unknown[]) => unknown>
const M = (typeof jest === 'undefined' ? vi : jest) as unknown as Timers

const c = (id: string, run: () => unknown) => {
  test(id, async () => {
    try {
      await observe(id, run)
    } finally {
      M.useRealTimers()
    }
  })
}

const kind = () => ({
  legacy: (setTimeout as unknown as { _isMockFunction?: boolean })._isMockFunction === true,
  modern: 'clock' in setTimeout,
})

c('useFakeTimers({ legacyFakeTimers: true }) installs this implementation', () => {
  M.useFakeTimers({ legacyFakeTimers: true })
  return kind()
})

c('useFakeTimers({ legacyFakeTimers: false }) installs the modern one', () => {
  M.useFakeTimers({ legacyFakeTimers: false })
  return kind()
})

c('a legacy install does not stop a later modern one', () => {
  M.useFakeTimers({ legacyFakeTimers: true })
  M.useFakeTimers()
  return kind()
})
