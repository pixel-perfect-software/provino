const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  jest.setTimeout(30_000)
})

test('a call inside a hook does not lift the timeout', async () => {
  await wait(250)
})

test('a call inside the body does not lift it either', async () => {
  jest.setTimeout(30_000)
  await wait(250)
})
