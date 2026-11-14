declare const __log: (marker: string) => void

beforeEach(() => __log('beforeEach root'))
afterEach(() => __log('afterEach root'))

test.concurrent('first', () => {
  __log('body first')
})
test('sequential', () => __log('body sequential'))
test.concurrent('second', () => {
  __log('body second')
})

describe('block', () => {
  test.concurrent('inner one', () => {
    __log('body inner one')
  })
  test.concurrent('inner two', () => {
    throw new Error('inner boom')
  })
})
