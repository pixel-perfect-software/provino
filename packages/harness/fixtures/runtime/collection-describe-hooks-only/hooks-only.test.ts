trace('file start')

describe('hooks without tests', () => {
  trace('hooks-only body')
  beforeEach(() => trace('beforeEach hooks-only'))
  afterAll(() => trace('afterAll hooks-only'))
})

test('runs anyway', () => trace('test runs anyway'))

trace('file end')
