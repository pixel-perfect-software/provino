describe('outer', () => {
  describe('inner', () => {
    test('counts', () => {
      expect(1).toMatchSnapshot()
      expect(2).toMatchSnapshot()
      expect(3).toMatchSnapshot()
    })

    test('hints', () => {
      expect('a').toMatchSnapshot('first')
      expect('b').toMatchSnapshot('first')
      expect('c').toMatchSnapshot('with: a colon')
      expect('d').toMatchSnapshot()
    })
  })

  test('same name', () => {
    expect('first of two').toMatchSnapshot()
  })

  test('same name', () => {
    expect('second of two').toMatchSnapshot()
  })
})

test.each([1, 2])('each row', (value) => {
  expect(value).toMatchSnapshot()
})

test('numbers 10', () => {
  expect(10).toMatchSnapshot()
})
test('numbers 2', () => {
  expect(2).toMatchSnapshot()
})
test('numbers 1', () => {
  expect(1).toMatchSnapshot()
})
test('Numbers upper', () => {
  expect('U').toMatchSnapshot()
})
test('a lower', () => {
  expect('l').toMatchSnapshot()
})

test('escapes `a back tick` and $' + '{a dollar brace}', () => {
  expect('escaped').toMatchSnapshot()
})
