// Calls that run past a default timeout. The golden's failure messages carry the timeout in ms.
// Concurrent, so the four waits overlap; each test keeps its own deadline.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.concurrent('timeouts', () => {
  test('a test over the default timeout', () => sleep(5300))

  describe('a hook over the default timeout', () => {
    beforeEach(() => sleep(10_300))
    test('t', () => {})
  })

  test('a test with a timeout of 0', () => sleep(5300), 0)

  describe('a cleanup over the hook timeout', () => {
    beforeEach(() => () => sleep(10_500))
    test('t', () => {})
  })
})
