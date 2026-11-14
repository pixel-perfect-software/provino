let calls = 0
let lastAttemptAt = 0

describe('waiting', () => {
  jest.retryTimes(1, { entireDescribe: true, waitBeforeRetry: 120 })

  test('waits before the retry', () => {
    const now = Date.now()
    const gap = calls === 0 ? 'first' : now - lastAttemptAt >= 100 ? 'waited' : 'did not wait'
    lastAttemptAt = now
    trace(`attempt ${++calls}: ${gap}`)
    if (calls < 2) throw new Error(`attempt ${calls} failed`)
  })
})
