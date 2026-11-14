declare const __log: (marker: string) => void

afterAll(() => {
  throw new Error('root afterAll boom')
})

describe('block', () => {
  afterAll(() => {
    throw new Error('block afterAll boom')
  })
  test('passes', () => __log('body passes'))
})
