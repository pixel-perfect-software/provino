// The same shape with `toMatchSnapshot` alone, for comparison: the retry takes back the first
// attempt's write and its count.
jest.retryTimes(1)

let attempts = 0

test('snapshot', () => {
  expect('value').toMatchSnapshot()
  attempts++
  if (attempts === 1) throw new Error('snapshot: first attempt')
})
