describe('snapshots', () => {
  it('matches a stored snapshot', () => {
    expect({ value: 'stored', list: [1, 2] }).toMatchSnapshot()
  })
})
