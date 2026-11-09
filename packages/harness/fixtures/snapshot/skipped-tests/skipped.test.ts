test('runs', () => {
  expect('ran').toMatchSnapshot()
})

test.skip('skipped', () => {
  expect('skipped').toMatchSnapshot()
})

describe.skip('skipped block', () => {
  test('inside', () => {
    expect('inside').toMatchSnapshot()
  })
})

test.todo('later')
