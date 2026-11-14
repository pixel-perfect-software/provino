const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('logs', async () => {
  console.log('msg-log')
  console.warn('msg-warn')
  await pause()
  expect(1).toBe(1)
})
