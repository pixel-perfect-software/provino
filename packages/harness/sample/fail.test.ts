describe('failing assertions', () => {
  it('toBe', () => {
    expect(1 + 2).toBe(4)
  })

  it('toEqual', () => {
    expect({ name: 'a', tags: ['x'] }).toEqual({ name: 'a', tags: ['y'] })
  })

  it('toThrow with the wrong message', () => {
    expect(() => {
      throw new Error('kaboom')
    }).toThrow('fizzle')
  })

  it('toThrow when nothing is thrown', () => {
    expect(() => 1).toThrow()
  })

  it('passes between failures', () => {
    expect(true).toBe(true)
  })
})

describe('failing throws', () => {
  it('an error with a cause', () => {
    throw new Error('outer', { cause: new Error('inner') })
  })

  it('a thrown string', () => {
    throw 'a string'
  })
})
