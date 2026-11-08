// The runner's expect, observed from inside a test.
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const failure = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}
const passes = (run: () => unknown): boolean => failure(run) === undefined
const api = expect as unknown as Record<string, unknown>

c('expect.errorShape', () => {
  const error = failure(() => expect(1).toBe(2)) as { name?: string } & object
  if ('matcherResult' in error && error.name === 'Error') return 'matcher-result'
  if (error.name === 'AssertionError') return 'assertion-error'
  return { name: error.name, keys: Object.keys(error) }
})

c('expect.equality.errors', () =>
  passes(() => expect(new Error('same')).toEqual(new TypeError('same'))) ? 'message' : 'assert',
)

c('expect.equality.invalidDate', () =>
  passes(() => expect(new Date(Number.NaN)).toEqual(new Date(Number.NaN))) ? 'equal' : 'unequal',
)

c('expect.soft', () => typeof api.soft === 'function')

c('expect.poll.enabled', () => typeof api.poll === 'function')

c('expect.diffContextLines', () => {
  const expected = Array.from({ length: 40 }, (_, index) => index)
  const received = expected.map((value) => (value === 20 ? -1 : value))
  // Jest puts the diff in the message. Vitest's message has none, and its runner adds the diff
  // after the test, so the fixture calls Vitest's own diff (`@vitest/utils/diff`, resolved from
  // the installed vitest) with its defaults (D27).
  let text: string
  if (typeof jest === 'undefined') {
    const { createRequire } = process.getBuiltinModule('node:module')
    const fromVitest = createRequire(require.resolve('vitest/package.json'))
    const { diff } = fromVitest('@vitest/utils/diff') as {
      diff: (a: unknown, b: unknown, options?: unknown) => string
    }
    text = diff(expected, received, { omitAnnotationLines: true }) ?? ''
  } else {
    text = String((failure(() => expect(received).toEqual(expected)) as Error).message)
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes
  text = text.replace(/\u001b\[[0-9;]*m/g, '')
  const lines = text.split('\n')
  const first = lines.findIndex((line) => /^[-+]\s+-?\d+,?$/.test(line))
  let context = 0
  while (first - context - 1 >= 0 && /^\s+\d+,$/.test(lines[first - context - 1] ?? '')) context++
  return context
})

test('a test with no assertion', () => {})

if (typeof api.poll === 'function') {
  test('expect.poll gives up', async () => {
    const poll = api.poll as (run: () => unknown) => { toBe(value: unknown): Promise<void> }
    let calls = 0
    const started = Date.now()
    let threw = false
    try {
      await poll(() => {
        calls++
        return false
      }).toBe(true)
    } catch {
      threw = true
    }
    const elapsed = Date.now() - started
    // Rounded: a poll's own timing has a few milliseconds of jitter.
    const timeout = Math.round(elapsed / 100) * 100
    await observe('expect.pollFailsOnTimeout', () => threw)
    await observe('expect.poll.timeoutMs', () => timeout)
    await observe('expect.poll.intervalMs', () => Math.round(timeout / calls / 10) * 10)
  })
}
