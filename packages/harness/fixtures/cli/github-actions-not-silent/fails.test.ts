const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('top level fails', async () => {
  await pause()
  expect(1).toBe(2)
})

describe('suite-b', () => {
  it('passes beside', async () => {
    await pause()
    expect(1).toBe(1)
  })

  describe('inner-b', () => {
    it('fails inside', async () => {
      await pause()
      expect('a').toBe('b')
    })
  })
})
