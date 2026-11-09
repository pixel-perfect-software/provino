const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('throws from its own timer while it waits', async () => {
  trace('test body')
  setTimeout(() => {
    trace('own timer fires')
    throw new Error('thrown by its own timer')
  }, 30)
  await sleep(120)
  trace('test ends')
})

describe('a timer left by beforeAll', () => {
  beforeAll(() => {
    setTimeout(() => {
      trace('beforeAll timer fires')
      throw new Error('thrown by a beforeAll timer')
    }, 30)
  })
  test('is running when it fires', async () => {
    trace('inner test starts')
    await sleep(120)
    trace('inner test ends')
  })
})

test('runs last', () => trace('last test'))
