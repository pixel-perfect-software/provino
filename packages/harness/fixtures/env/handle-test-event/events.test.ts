declare const __log: (marker: string) => void

let flaky = 0
jest.retryTimes(1)

beforeAll(() => __log('beforeAll root'))
afterEach(() => __log('afterEach root'))

describe('outer', () => {
  beforeAll(() => __log('beforeAll outer'))

  describe('inner', () => {
    test('passes', () => __log('body passes'))
    test('fails', () => {
      __log('body fails')
      throw new Error('boom')
    })
  })

  describe('failing beforeEach', () => {
    beforeEach(() => {
      throw new Error('hook boom')
    })
    test('body never runs', () => __log('body never runs'))
  })

  test.skip('skipped', () => __log('body skipped'))
  test.todo('todo item')
})

describe('whole block retried', () => {
  jest.retryTimes(1, { entireDescribe: true })
  beforeAll(() => __log('beforeAll whole block'))
  test('flaky', () => {
    __log('body flaky')
    if (++flaky === 1) throw new Error('first try')
  })
})
