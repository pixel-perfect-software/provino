it('intercepts in the second file too', async () => {
  expect(await (await fetch('https://api.example.invalid/user')).json()).toEqual({ name: 'ada' })
  await expect(fetch('https://api.example.invalid/again-unhandled')).rejects.toThrow()
})
