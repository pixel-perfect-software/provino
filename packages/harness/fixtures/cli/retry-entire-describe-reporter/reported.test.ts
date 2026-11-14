let attempt = 0

describe('retried', () => {
  jest.retryTimes(1, { entireDescribe: true })
  beforeAll(() => {
    attempt++
  })

  test('fails first', () => {
    if (attempt === 1) {
      expect(1).toBe(1)
      expect(2).toBe(2)
      expect(3).toBe(3)
      expect(attempt).toBe(2)
    }
    expect(attempt).toBe(2)
  })

  test('passes', () => {
    for (let i = 0; i < attempt; i++) expect(i).toBe(i)
  })
})
