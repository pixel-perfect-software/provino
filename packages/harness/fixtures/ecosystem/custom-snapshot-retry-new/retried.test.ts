// Every test's first attempt takes its snapshots through the custom matchers and then fails; the
// retry takes them again and passes. What the first attempt counted, checked and wrote is taken
// back, so the retry's snapshots have the first attempt's keys.
jest.retryTimes(1)

const attempts = new Map<string, number>()
/** Which attempt of the test this is, from 1. */
function attempt(test: string): number {
  const n = (attempts.get(test) ?? 0) + 1
  attempts.set(test, n)
  return n
}

test('trimmed, then fails once', () => {
  const n = attempt('trimmed')
  expect('extra long string oh my gerd').toMatchTrimmedSnapshot(10)
  expect('second, trimmed').toMatchTrimmedSnapshot(6)
  if (n === 1) throw new Error('the first attempt fails after its snapshots')
})

test('beside toMatchSnapshot, then fails once', () => {
  const n = attempt('beside')
  expect('first').toMatchSnapshot()
  expect('trimmed and more').toMatchTrimmedSnapshot(7)
  if (n === 1) throw new Error('the first attempt fails after its snapshots')
})

test('property matchers fail once', () => {
  const n = attempt('properties')
  expect(n === 1 ? { id: 'seven', name: 'seven' } : { id: 7, name: 'seven' }).toMatchIdSnapshot()
})
