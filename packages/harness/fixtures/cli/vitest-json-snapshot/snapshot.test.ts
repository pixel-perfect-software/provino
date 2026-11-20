describe('group', () => {
  test('changed value', () => {
    expect('new value').toMatchSnapshot()
  })
  test('unchanged value', () => {
    expect('same').toMatchSnapshot()
  })
  test('new value', () => {
    expect('added').toMatchSnapshot()
  })
})

test('outside', () => {
  expect(1).toBe(1)
})
