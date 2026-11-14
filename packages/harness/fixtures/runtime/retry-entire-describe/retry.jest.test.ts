let flakyCalls = 0
let lateCalls = 0

beforeAll(() => trace('beforeAll root'))
afterAll(() => trace('afterAll root'))

describe('retried', () => {
  jest.retryTimes(2, { entireDescribe: true })
  beforeAll(() => trace('beforeAll retried'))
  afterAll(() => trace('afterAll retried'))
  beforeEach(() => trace('beforeEach retried'))
  afterEach(() => trace('afterEach retried'))

  test('fails once', () => {
    trace('fails once body')
    if (++flakyCalls === 1) throw new Error('fails once failed')
  })

  test('always passes', () => trace('always passes body'))

  test('fails twice', () => {
    trace('fails twice body')
    if (++lateCalls <= 2) throw new Error(`fails twice failed ${lateCalls}`)
  })
})

describe('after', () => {
  test('is not retried', () => trace('after body'))
})
