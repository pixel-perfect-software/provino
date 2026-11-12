test('changed', () => {
  expect('new value').toMatchSnapshot()
})

test('unchanged', () => {
  expect('same').toMatchSnapshot()
})

test('added', () => {
  expect('fresh').toMatchSnapshot()
})
