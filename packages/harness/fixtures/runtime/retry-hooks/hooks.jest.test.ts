jest.retryTimes(1)

let bodyCalls = 0

beforeAll(() => trace('beforeAll root'))
afterAll(() => trace('afterAll root'))
beforeEach(() => trace('beforeEach root'))
afterEach(() => trace('afterEach root'))

test('body fails once', () => {
  trace('body')
  if (++bodyCalls === 1) throw new Error('body failed')
})

describe('beforeEach fails once', () => {
  let calls = 0
  beforeAll(() => trace('beforeAll first'))
  afterAll(() => trace('afterAll first'))
  beforeEach(() => {
    trace('beforeEach first')
    if (++calls === 1) throw new Error('beforeEach failed')
  })
  afterEach(() => trace('afterEach first'))

  test('first', () => trace('first body'))
})

describe('afterEach fails once', () => {
  let calls = 0
  beforeAll(() => trace('beforeAll second'))
  afterAll(() => trace('afterAll second'))
  beforeEach(() => trace('beforeEach second'))
  afterEach(() => {
    trace('afterEach second')
    if (++calls === 1) throw new Error('afterEach failed')
  })

  test('second', () => trace('second body'))
})
