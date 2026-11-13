// Every test waits a little, so Jest's verbose list shows a time after each one on every run (a
// test under a millisecond has none, and the recording must not depend on the machine's speed).
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('math', () => {
  it('adds', async () => {
    console.log('from the test')
    await pause()
    expect(1 + 1).toBe(2)
  })
})

it.skip('is skipped', () => {
  expect(1).toBe(2)
})

it.todo('is planned')
