declare const __log: (marker: string) => void

beforeAll(() => __log('beforeAll root'))
afterAll(() => __log('afterAll root'))
beforeEach(() => __log('beforeEach root'))

describe('block', () => {
  afterEach(() => __log('afterEach block'))
  test('passes', () => __log('body passes'))
  test('fails', () => {
    __log('body fails')
    throw new Error('boom')
  })
})
