// A failed test retried once. `steps` records the order; the test context's task says what the
// second attempt carries from the first.
const steps: string[] = []
let attempts = 0
let errorsOnRetry = -1

test('fails once, then passes', { retry: 1 }, (context) => {
  attempts += 1
  steps.push(`attempt ${attempts}`)
  if (attempts === 1) throw new Error('first attempt')
  errorsOnRetry = context.task.result?.errors?.length ?? 0
})

test('the next test', () => {
  steps.push('next')
})

let failures = 0
test('fails every attempt', { retry: 1 }, () => {
  failures += 1
  throw new Error(`attempt ${failures}`)
})

afterAll(async () => {
  await observe('core.retry.timing', () =>
    steps.join(', ') === 'attempt 1, attempt 2, next' ? 'immediate' : steps.join(', '),
  )
  await observe('retry: errors the second attempt starts with', () => errorsOnRetry)
})
