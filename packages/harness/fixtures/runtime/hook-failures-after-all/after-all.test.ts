describe('afterAll throws', () => {
  afterAll(() => {
    trace('afterAll #1')
    throw new Error('afterAll #1 failed')
  })
  afterAll(() => trace('afterAll #2'))

  test('test 1', () => trace('test 1'))
  test('test 2', () => trace('test 2'))
})

describe('after the failing describe', () => {
  afterAll(() => trace('afterAll other'))

  test('test 3', () => trace('test 3'))
})
