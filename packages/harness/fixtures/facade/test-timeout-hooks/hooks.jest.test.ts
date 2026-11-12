const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a slow beforeAll', () => {
  beforeAll(async () => {
    await wait(250)
  })
  test('is not run', () => {})
})

describe('a slow beforeEach', () => {
  beforeEach(async () => {
    await wait(250)
  })
  test('fails with the hook', () => {})
})

describe('a slow afterAll', () => {
  afterAll(async () => {
    await wait(250)
  })
  test('runs', () => {})
})

describe('a hook with its own timeout', () => {
  beforeAll(async () => {
    await wait(250)
  }, 500)
  beforeEach(async () => {
    await wait(250)
  }, 500)
  test('passes', () => {})
})
