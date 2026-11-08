// Retried with Jest's default options.
jest.retryTimes(1)

let attempts = 0
test('fails once with the default options', () => {
  attempts += 1
  if (attempts === 1) throw new Error('first attempt (default options)')
})
