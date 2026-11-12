const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('without the call, the configured default applies', async () => {
  await wait(250)
})
