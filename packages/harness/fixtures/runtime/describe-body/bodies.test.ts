trace('file start')

describe('A', () => {
  trace('A body start')

  describe('A1', () => {
    trace('A1 body')
    test('test A1', () => trace('test A1'))
  })

  trace('A body end')
  test('test A', () => trace('test A'))
})

trace('after describe A')

describe('B', () => {
  trace('B body')
  test('test B', () => trace('test B'))
})

trace('file end')
