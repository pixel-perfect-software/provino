jest.retryTimes(2, { waitBeforeRetry: 120 })

let calls = 0
let lastAttemptAt = 0

test('waits before each retry', () => {
  const now = Date.now()
  const gap = calls === 0 ? 'first' : now - lastAttemptAt >= 100 ? 'waited' : 'did not wait'
  lastAttemptAt = now
  trace(`attempt ${++calls}: ${gap}`)
  if (calls < 3) throw new Error(`attempt ${calls} failed`)
})

test('another test, with no retry needed', () => trace('another'))
