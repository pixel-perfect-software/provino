function hooks(level: string): void {
  aroundAll(async (runSuite) => {
    trace(`aroundAll ${level} #1 setup`)
    await runSuite()
    trace(`aroundAll ${level} #1 teardown`)
  })
  aroundAll(async (runSuite) => {
    trace(`aroundAll ${level} #2 setup`)
    await runSuite()
    trace(`aroundAll ${level} #2 teardown`)
  })
  aroundEach(async (runTest) => {
    trace(`aroundEach ${level} #1 setup`)
    await runTest()
    trace(`aroundEach ${level} #1 teardown`)
  })
  aroundEach(async (runTest) => {
    trace(`aroundEach ${level} #2 setup`)
    await runTest()
    trace(`aroundEach ${level} #2 teardown`)
  })
  beforeAll(() => trace(`beforeAll ${level}`))
  beforeEach(() => trace(`beforeEach ${level}`))
  afterEach(() => trace(`afterEach ${level} #1`))
  afterEach(() => trace(`afterEach ${level} #2`))
  afterAll(() => trace(`afterAll ${level} #1`))
  afterAll(() => trace(`afterAll ${level} #2`))
}

hooks('L1')

test('test L1', () => trace('test L1'))

describe('L2', () => {
  hooks('L2')

  test('test L2a', () => trace('test L2a'))
  test('test L2b', () => trace('test L2b'))
})
