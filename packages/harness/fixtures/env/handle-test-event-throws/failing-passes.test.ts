declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

__throwAt({ event: 'test_fn_failure', test: 'passes' })
test.failing('passes', () => __log('body passes'))
test('b', () => __log('body b'))
