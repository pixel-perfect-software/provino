test('waits: a while', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
