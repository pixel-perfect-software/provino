declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

// The second: the first is the adapter's own root beforeEach.
__throwAt({ event: 'hook_success', test: 'a', nth: 2 })
beforeEach(() => __log('beforeEach root'))
afterAll(() => __log('afterAll root'))
test('a', () => __log('body a'))
test('b', () => __log('body b'))
