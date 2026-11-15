const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('top level passes', async () => {
  await pause()
  expect(1).toBe(1)
})

describe('suite-a', () => {
  it('first', async () => {
    await pause()
    expect(1).toBe(1)
  })

  describe('inner-a', () => {
    it('second', async () => {
      await pause()
      expect(2).toBe(2)
    })

    it.skip('skipped one', () => {})
    it.todo('todo one')
  })
})
