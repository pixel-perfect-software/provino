const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function explode(): never {
  throw new Error('from a helper')
}

describe('frames', () => {
  it('fails toBe', () => {
    const received: number = 1
    expect(received).toBe(2)
  })

  it('fails toBe after an await', async () => {
    await pause()
    expect(1).toBe(2)
  })

  it('fails toEqual', () => {
    expect({ a: 1 }).toEqual({ a: 2 })
  })

  it('fails toThrow', () => {
    expect(() => 1).toThrow()
  })

  it('throws in a helper', () => {
    explode()
  })

  it('rejects', async () => {
    await expect(Promise.resolve(1)).rejects.toThrow('nope')
  })

  it.each([[1], [2]])('fails each %i', (n: number) => {
    expect(n).toBe(0)
  })
})
