// The first test fails; whether the second runs depends on when bail checks.
test('fails first', () => {
  throw new Error('failed')
})

test('would pass next', () => {})
