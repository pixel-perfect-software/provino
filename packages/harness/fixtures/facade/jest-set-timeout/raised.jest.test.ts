const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('declared before the call: the raised default applies', async () => {
  await wait(250)
})

jest.setTimeout(500)

test('declared after the call: the raised default applies', async () => {
  await wait(250)
})
test('an explicit timeout wins', async () => {
  await wait(250)
}, 100)
