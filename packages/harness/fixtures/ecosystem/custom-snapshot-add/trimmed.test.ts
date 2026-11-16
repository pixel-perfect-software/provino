// Each test's snapshots go through the matchers in `setup.ts`. The trimmed one's hint gives it a
// name of its own, so beside it the test's `toMatchSnapshot` calls are its snapshots 1 and 2.
test('trimmed', () => {
  expect('extra long string oh my gerd').toMatchTrimmedSnapshot(10)
})

test('beside toMatchSnapshot', () => {
  expect('first').toMatchSnapshot()
  expect('second, trimmed').toMatchTrimmedSnapshot(6)
  expect('third').toMatchSnapshot()
})

test('with properties', () => {
  expect({ id: 7, name: 'seven' }).toMatchIdSnapshot()
})

test('a thrown error', () => {
  expect(() => {
    throw new Error('boom, and more')
  }).toThrowTrimmedSnapshot()
})
