const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('async', () => {
  it('awaits a promise', async () => {
    await wait(1)
    await expect(Promise.resolve(3)).resolves.toBe(3)
  })

  it('rejects', async () => {
    await expect(Promise.reject(new Error('no'))).rejects.toThrow('no')
  })
})
