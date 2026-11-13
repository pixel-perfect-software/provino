jest.retryTimes(1)

let attempts = 0

it('passes on the second attempt', () => {
  attempts += 1
  if (attempts === 1) throw new Error('first attempt')
})

describe('group', () => {
  it('passes at once', () => {
    console.log('from a test')
  })
})
