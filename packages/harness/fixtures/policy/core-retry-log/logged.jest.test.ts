// Retried with the earlier errors logged.
jest.retryTimes(1, { logErrorsBeforeRetry: true })

let attempts = 0
test('fails once with logErrorsBeforeRetry', () => {
  attempts += 1
  if (attempts === 1) throw new Error('first attempt (logErrorsBeforeRetry)')
})
