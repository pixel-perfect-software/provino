it('fails a stored snapshot', () => {
  expect({ value: 'new' }).toMatchSnapshot()
})
