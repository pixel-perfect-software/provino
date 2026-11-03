test('outer', () => {
  trace('test outer start')
  test('inner', () => trace('test inner'))
  trace('test outer after inner call')
})

test('next', () => trace('test next'))
