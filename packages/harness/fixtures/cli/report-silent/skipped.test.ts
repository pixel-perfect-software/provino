it('runs', () => {
  expect(1).toBe(1)
})

it.skip('is skipped', () => {
  expect(1).toBe(2)
})

it.todo('is planned')
