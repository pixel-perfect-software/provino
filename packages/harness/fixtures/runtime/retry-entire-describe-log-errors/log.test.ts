let calls = 0
let quiet = 0

describe('logged', () => {
  jest.retryTimes(2, { entireDescribe: true, logErrorsBeforeRetry: true })

  test('fails twice then passes', () => {
    if (++calls <= 2) throw new Error(`logged failed #${calls}`)
  })

  test('never fails', () => {})
})

describe('every attempt fails', () => {
  jest.retryTimes(1, { entireDescribe: true, logErrorsBeforeRetry: true })

  test('keeps failing', () => {
    throw new Error(`kept failing #${++quiet}`)
  })
})
