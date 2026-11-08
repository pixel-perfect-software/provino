// Calls that run past a default timeout. The golden's failure messages carry the timeout in ms.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('a test over the default timeout', () => sleep(5300))

describe('a hook over the default timeout', () => {
  beforeEach(() => sleep(5300))
  test('t', () => {})
})

test('a test with a timeout of 0', () => sleep(5300), 0)
