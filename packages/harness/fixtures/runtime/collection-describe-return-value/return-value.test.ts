trace('file start')

describe('returns a value', () => {
  trace('body')
  test('inside', () => trace('test inside'))
  return 42
})

trace('file end')
