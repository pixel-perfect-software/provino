it.skip('skipped with it.skip', () => {
  throw new Error('never runs')
})

test.skip('skipped with test.skip', () => {
  throw new Error('never runs')
})

describe.skip('a skipped describe', () => {
  it('is skipped too', () => {
    throw new Error('never runs')
  })

  it('and so is this one', () => {
    throw new Error('never runs')
  })
})

it.todo('a todo')

test.todo('another todo')

it('runs beside them', () => {
  expect(1).toBe(1)
})
