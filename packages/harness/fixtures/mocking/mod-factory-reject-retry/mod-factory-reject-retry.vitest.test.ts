function mockAttempt(counter: 'attempts' | 'asyncAttempts'): number {
  const g = globalThis as Record<string, number | undefined>
  g[counter] = (g[counter] ?? 0) + 1
  return g[counter] ?? 0
}

vi.mock('./flaky.ts', () => {
  const attempt = mockAttempt('attempts')
  if (attempt === 1) throw new Error('factory failed on attempt 1')
  return { value: `mock-attempt-${attempt}` }
})

vi.mock('./flaky-async.ts', async () => {
  const attempt = mockAttempt('asyncAttempts')
  if (attempt === 1) throw new Error('async factory failed on attempt 1')
  return { value: `mock-async-attempt-${attempt}` }
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const counts = () => {
  const g = globalThis as { attempts?: number; asyncAttempts?: number }
  return { attempts: g.attempts, asyncAttempts: g.asyncAttempts }
}

c('the first load throws the factory error', async () => {
  const first = (await import('./flaky.ts')) as { value: string }
  return { value: first.value }
})

c('the next load runs the factory again and gets the value', async () => {
  const second = (await import('./flaky.ts')) as { value: string }
  return { value: second.value, ...counts() }
})

c('after the retry the module is cached', async () => {
  const third = (await import('./flaky.ts')) as { value: string }
  return { value: third.value, ...counts() }
})

c('an async factory that rejects: the first load', async () => {
  const first = (await import('./flaky-async.ts')) as { value: string }
  return { value: first.value }
})

c('an async factory that rejects: the next load', async () => {
  const second = (await import('./flaky-async.ts')) as { value: string }
  return { value: second.value, ...counts() }
})
