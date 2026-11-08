function mockAttempt(): number {
  const g = globalThis as { attempts?: number }
  g.attempts = (g.attempts ?? 0) + 1
  return g.attempts
}

jest.mock('./flaky.ts', () => {
  const attempt = mockAttempt()
  if (attempt === 1) throw new Error('factory failed on attempt 1')
  return { value: `mock-attempt-${attempt}` }
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const attempts = () => (globalThis as { attempts?: number }).attempts

c('the first load throws the factory error', () => {
  const first = require('./flaky.ts') as { value: string }
  return { value: first.value }
})

c('the next load runs the factory again and gets the value', () => {
  const second = require('./flaky.ts') as { value: string }
  return { value: second.value, attempts: attempts() }
})

c('after the retry the module is cached', () => {
  const third = require('./flaky.ts') as { value: string }
  return { value: third.value, attempts: attempts() }
})
