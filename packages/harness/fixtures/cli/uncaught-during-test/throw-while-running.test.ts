test('a timer throws while the test awaits', async () => {
  setTimeout(() => {
    throw new Error('thrown while its test runs')
  }, 0)
  await new Promise((resolve) => setTimeout(resolve, 30))
})
