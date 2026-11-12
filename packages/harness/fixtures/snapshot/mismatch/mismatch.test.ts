test('changed value', () => {
  expect('new value').toMatchSnapshot()
})

test('unchanged value', () => {
  expect('same').toMatchSnapshot()
})
