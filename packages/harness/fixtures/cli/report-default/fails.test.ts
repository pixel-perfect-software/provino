const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('group', () => {
  it('fails', async () => {
    await pause()
    expect(1).toBe(2)
  })

  it('passes after', async () => {
    await pause()
    expect(1).toBe(1)
  })
})
