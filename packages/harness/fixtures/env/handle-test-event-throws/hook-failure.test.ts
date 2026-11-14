declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

__throwAt({ event: 'hook_failure' })
beforeEach(() => {
  throw new Error('beforeEach boom')
})
afterAll(() => __log('afterAll root'))
test('a', () => __log('body a'))
test('b', () => __log('body b'))
