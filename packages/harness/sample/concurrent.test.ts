const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('concurrent tests', () => {
  it.concurrent('the slowest', async () => {
    await pause(30)
    expect(1).toBe(1)
  })

  it.concurrent('a quicker one', async () => {
    await pause(10)
    expect(2).toBe(2)
  })

  it.concurrent('one that does not wait', async () => {
    expect(3).toBe(3)
  })
})
