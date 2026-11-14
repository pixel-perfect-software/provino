declare const __log: (marker: string) => void

test.failing('throws as expected', () => {
  __log('body throws as expected')
  throw new Error('expected boom')
})

test.failing('passes unexpectedly', () => {
  __log('body passes unexpectedly')
})

test('plain', () => __log('body plain'))
