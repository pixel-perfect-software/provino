declare const __log: (marker: string) => void
declare const __throwAt: (plan: {
  event: string
  test?: string
  block?: string
  nth?: number
}) => void

__throwAt({ event: 'test_start', test: 'b' })
afterAll(() => __log('afterAll root'))
describe('block', () => {
  afterEach(() => __log('afterEach block'))
  afterAll(() => __log('afterAll block'))
  test('a', () => __log('body a'))
  test('b', () => __log('body b'))
})
test('c', () => __log('body c'))
