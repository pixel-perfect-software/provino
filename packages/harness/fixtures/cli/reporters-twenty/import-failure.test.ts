function load(): never {
  throw new Error('this file fails as it loads')
}

load()

describe('never reached', () => {
  it('does not run', () => {
    expect(1).toBe(1)
  })
})
