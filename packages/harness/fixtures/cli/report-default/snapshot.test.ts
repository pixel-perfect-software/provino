const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('matches a stored snapshot', async () => {
  await pause()
  expect({ value: 'new' }).toMatchSnapshot()
})
