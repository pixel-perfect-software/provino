const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

it('finishes within its timeout', async () => {
  await pause(5)
  expect(1).toBe(1)
}, 1000)

it('runs past its timeout', async () => {
  await pause(500)
}, 50)
