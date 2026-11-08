it.only('the focused test runs', () => {
  expect(1).toBe(1)
})

it('an unfocused test is skipped', () => {
  throw new Error('never runs')
})

it('so is this one', () => {
  throw new Error('never runs')
})
