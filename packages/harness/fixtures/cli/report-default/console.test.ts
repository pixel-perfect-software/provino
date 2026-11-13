const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('logs and warns', async () => {
  console.log('from the test')
  console.warn('a warning')
  await pause()
  expect(1).toBe(1)
})
