// context-expect runs the same bodies with Vitest's context expect.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('global expect under test.concurrent', () => {
  test.concurrent('assertions(1) met after 20 ms', async () => {
    expect.assertions(1)
    await sleep(20)
    expect('c1').toBe('c1')
  })

  test.concurrent('assertions(2) met after 40 ms', async () => {
    expect.assertions(2)
    await sleep(40)
    expect('c2').toBe('c2')
    expect(2).toBe(2)
  })

  test.concurrent('hasAssertions met after 60 ms', async () => {
    expect.hasAssertions()
    await sleep(60)
    expect('c3').toBe('c3')
  })

  test.concurrent('assertions(1) missed after 80 ms', async () => {
    expect.assertions(1)
    await sleep(80)
  })

  test.concurrent('hasAssertions missed after 100 ms', async () => {
    expect.hasAssertions()
    await sleep(100)
  })
})
