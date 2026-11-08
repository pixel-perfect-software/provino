// A failed test retried once; `steps` records the order. Whether the earlier error is logged is
// `core-retry-log`'s (the runner's output shows it, the JSON doesn't).
jest.retryTimes(1)

const steps: string[] = []
let attempts = 0

test('fails once, then passes', () => {
  attempts += 1
  steps.push(`attempt ${attempts}`)
  if (attempts === 1) throw new Error('first attempt')
})

test('the next test', () => {
  steps.push('next')
})

let failures = 0
test('fails every attempt', () => {
  failures += 1
  throw new Error(`attempt ${failures}`)
})

afterAll(async () => {
  await observe('core.retry.timing', () =>
    steps.join(', ') === 'attempt 1, next, attempt 2' ? 'deferred' : steps.join(', '),
  )
})
