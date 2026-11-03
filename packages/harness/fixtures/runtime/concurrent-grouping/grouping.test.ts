const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('interleaved', () => {
  beforeEach(() => trace('beforeEach interleaved'))
  afterEach(() => trace('afterEach interleaved'))

  test('s1', () => trace('test s1'))
  test.concurrent('c1', async () => {
    trace('test c1 start')
    await sleep(30)
    trace('test c1 end')
  })
  test('s2', () => trace('test s2'))
  test.concurrent('c2', async () => {
    trace('test c2 start')
    await sleep(60)
    trace('test c2 end')
  })
})

describe('consecutive', () => {
  beforeEach(() => trace('beforeEach consecutive'))
  afterEach(() => trace('afterEach consecutive'))

  test.concurrent('c3', async () => {
    trace('test c3 start')
    await sleep(30)
    trace('test c3 end')
  })
  test.concurrent('c4', async () => {
    trace('test c4 start')
    await sleep(60)
    trace('test c4 end')
  })
  test('s3', () => trace('test s3'))
})
