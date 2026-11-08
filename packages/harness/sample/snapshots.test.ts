describe('file snapshots', () => {
  it('an object', () => {
    expect({ id: 1, tags: ['a', 'b'] }).toMatchSnapshot()
  })

  it('with a hint', () => {
    expect('hinted').toMatchSnapshot('hint')
  })

  describe('nested', () => {
    it('a string', () => {
      expect('nested value').toMatchSnapshot()
    })
  })

  it('a thrown error', () => {
    expect(() => {
      throw new Error('kaboom')
    }).toThrowErrorMatchingSnapshot()
  })
})

describe('inline snapshots', () => {
  it('a string', () => {
    expect('inline').toMatchInlineSnapshot(`"inline"`)
  })

  it('a number', () => {
    expect(42).toMatchInlineSnapshot(`42`)
  })
})
