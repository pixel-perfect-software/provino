describe('late registration', () => {
  beforeAll(() => {
    trace('beforeAll start')
    test('registered late', () => trace('test registered late'))
    trace('beforeAll end')
  })

  test('registered early', () => trace('test registered early'))
})
