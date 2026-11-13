// Every test waits a little, so Jest's verbose list shows a time after each one on every run (a
// test under a millisecond has none, and the recording must not depend on the machine's speed).
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('math', () => {
  it('adds', async () => {
    await pause()
    expect(1 + 1).toBe(2)
  })

  describe('nested', () => {
    it('subtracts', async () => {
      await pause()
      expect(3 - 1).toBe(2)
    })
  })
})

it('stands alone', async () => {
  await pause()
  expect(true).toBe(true)
})
