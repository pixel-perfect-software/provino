describe('passing assertions', () => {
  it('toBe', () => {
    expect(1 + 1).toBe(2)
  })

  it('toEqual', () => {
    expect({ a: [1, 2], b: { c: 'd' } }).toEqual({ a: [1, 2], b: { c: 'd' } })
  })

  it('toContain and toMatch', () => {
    expect(['a', 'b']).toContain('b')
    expect('provino').toMatch(/vin/)
  })

  it('toThrow', () => {
    expect(() => {
      throw new TypeError('bad input')
    }).toThrow(TypeError)
  })

  it('resolves', async () => {
    await expect(Promise.resolve(3)).resolves.toBe(3)
  })

  it('rejects', async () => {
    await expect(Promise.reject(new Error('no'))).rejects.toThrow('no')
  })
})
