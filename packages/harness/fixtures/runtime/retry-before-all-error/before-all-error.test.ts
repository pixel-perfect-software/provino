jest.retryTimes(2)

const calls: Record<string, number> = {}

/** A test body that fails its first `failures` calls and traces every call. */
function flaky(name: string, failures: number): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    if (calls[name] <= failures) throw new Error(`${name} failed #${calls[name]}`)
  }
}

describe('deferred retries', () => {
  beforeAll(() => {
    trace('beforeAll deferred')
    throw new Error('beforeAll deferred failed')
  })
  beforeEach(() => trace('beforeEach deferred'))
  afterEach(() => trace('afterEach deferred'))

  test('under the failed beforeAll', flaky('under', 0))

  describe('nested', () => {
    test('nested under the failed beforeAll', flaky('nested', 0))
  })
})

describe('immediate retries', () => {
  beforeAll(() => {
    jest.retryTimes(2, { retryImmediately: true })
    trace('beforeAll immediate')
    throw new Error('beforeAll immediate failed')
  })
  afterEach(() => trace('afterEach immediate'))

  test('under the failed beforeAll, retried at once', flaky('immediate', 0))
})

describe('control: the beforeAll passes', () => {
  beforeAll(() => {
    jest.retryTimes(2)
    trace('beforeAll control')
  })
  afterEach(() => trace('afterEach control'))

  test('fails once and is retried', flaky('control', 1))
})
