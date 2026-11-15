test('waits', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30_000))
}, 60_000)
