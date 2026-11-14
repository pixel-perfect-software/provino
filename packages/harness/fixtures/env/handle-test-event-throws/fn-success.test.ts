declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

__throwAt({ event: 'test_fn_success', test: 'a' })
afterEach(() => __log('afterEach root'))
test('a', () => __log('body a'))
test('b', () => __log('body b'))
