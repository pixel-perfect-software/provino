let calls = 0

jest.retryTimes(2)

describe('retry', () => {
  it('passes on its second attempt', () => {
    calls++
    expect(calls).toBeGreaterThan(1)
  })

  it('fails every attempt', () => {
    throw new Error('always')
  })
})
