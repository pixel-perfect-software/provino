const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('runs', async () => {
  await pause()
  expect(1).toBe(1)
})

it.skip('is skipped', () => {
  expect(1).toBe(2)
})

it.todo('is planned')
