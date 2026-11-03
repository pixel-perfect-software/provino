afterEach(() => trace('afterEach root'))

describe('beforeAll throws', () => {
  beforeAll(() => {
    trace('beforeAll A #1')
    throw new Error('beforeAll A #1 failed')
  })
  beforeAll(() => trace('beforeAll A #2'))
  beforeEach(() => trace('beforeEach A'))
  afterEach(() => trace('afterEach A'))
  afterAll(() => trace('afterAll A'))

  test('test A1', () => trace('test A1'))
  test('test A2', () => trace('test A2'))

  describe('nested under the failed beforeAll', () => {
    beforeAll(() => trace('beforeAll A nested'))
    beforeEach(() => trace('beforeEach A nested'))
    afterEach(() => trace('afterEach A nested'))
    afterAll(() => trace('afterAll A nested'))

    test('test A3', () => trace('test A3'))
  })
})

describe('beforeEach throws', () => {
  beforeEach(() => trace('beforeEach B #1'))
  beforeEach(() => {
    trace('beforeEach B #2')
    throw new Error('beforeEach B #2 failed')
  })
  beforeEach(() => trace('beforeEach B #3'))
  afterEach(() => trace('afterEach B #1'))
  afterEach(() => trace('afterEach B #2'))

  test('test B1', () => trace('test B1'))
  test('test B2', () => trace('test B2'))
})

describe('afterEach throws', () => {
  afterEach(() => trace('afterEach C parent'))

  describe('with sibling and parent afterEach hooks', () => {
    afterEach(() => trace('afterEach C #1'))
    afterEach(() => {
      trace('afterEach C #2')
      throw new Error('afterEach C #2 failed')
    })
    afterEach(() => trace('afterEach C #3'))

    test('test C1', () => trace('test C1'))
    test('test C2', () => trace('test C2'))
  })
})

describe('afterAll throws', () => {
  afterAll(() => {
    trace('afterAll D #1')
    throw new Error('afterAll D #1 failed')
  })
  afterAll(() => trace('afterAll D #2'))

  test('test D1', () => trace('test D1'))
  test('test D2', () => trace('test D2'))
})
