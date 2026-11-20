test('two snapshots differ', () => {
  expect('new a').toMatchSnapshot()
  trace('after the first snapshot')
  expect('new b').toMatchSnapshot()
  trace('after the second snapshot')
})
