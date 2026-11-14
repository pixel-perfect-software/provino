declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

__throwAt({ event: 'run_describe_start', block: 'inner' })
afterAll(() => __log('afterAll root'))
describe('outer', () => {
  afterAll(() => __log('afterAll outer'))
  test('first', () => __log('body first'))
  describe('inner', () => {
    test('never', () => __log('body never'))
  })
})
