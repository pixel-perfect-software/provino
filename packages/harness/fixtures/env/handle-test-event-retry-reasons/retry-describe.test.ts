declare const __log: (marker: string) => void

let calls = 0

describe('outer', () => {
  beforeAll(() => {
    throw new Error('outer beforeAll boom')
  })

  describe('inner', () => {
    jest.retryTimes(1, { entireDescribe: true, logErrorsBeforeRetry: true })
    afterEach(() => {
      calls += 1
      if (calls === 1) throw new Error('afterEach boom')
    })
    test('under a failed beforeAll', () => __log('body under a failed beforeAll'))
  })
})

describe('whole block', () => {
  let tries = 0
  jest.retryTimes(1, { entireDescribe: true, logErrorsBeforeRetry: true })
  test('flaky', () => {
    tries += 1
    if (tries === 1) throw new Error('first try')
  })
})
