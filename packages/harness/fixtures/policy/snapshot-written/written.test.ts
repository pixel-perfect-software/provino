// Three snapshots in a nested test; the run writes them to the .snap file the golden captures.
describe('outer', () => {
  test('inner', () => {
    expect('a "quoted" \\ string').toMatchSnapshot()
    expect({ a: 1 }).toMatchSnapshot('hint')
    expect(() => {
      throw new Error('boom')
    }).toThrowErrorMatchingSnapshot()
  })
})
