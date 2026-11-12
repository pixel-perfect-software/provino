const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

jest.setTimeout(-1)

test('a negative timeout', async () => {
  await wait(250)
})
