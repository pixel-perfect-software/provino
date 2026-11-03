function hooks(level: string): void {
  beforeAll(() => {
    trace(`beforeAll ${level} #1`)
    return () => trace(`teardown beforeAll ${level} #1`)
  })
  beforeAll(() => {
    trace(`beforeAll ${level} #2`)
    return () => trace(`teardown beforeAll ${level} #2`)
  })
  beforeEach(() => {
    trace(`beforeEach ${level} #1`)
    return () => trace(`teardown beforeEach ${level} #1`)
  })
  beforeEach(async () => {
    trace(`beforeEach ${level} #2`)
    return () => trace(`teardown beforeEach ${level} #2`)
  })
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
