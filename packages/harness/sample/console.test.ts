beforeAll(() => {
  console.log('beforeAll: output outside any test')
})

describe('console', () => {
  afterEach(() => {
    console.log('afterEach one')
  })

  afterEach(() => {
    console.log('afterEach two')
  })

  it('logs at every level', () => {
    console.log('log line', 1)
    console.info('info line')
    console.warn('warn line')
    console.error('error line')
    console.debug('debug line')
    expect(true).toBe(true)
  })

  it('splits a multi-line write into lines', () => {
    console.log('first\nsecond\nthird')
    expect(true).toBe(true)
  })

  it('logs nothing itself', () => {
    expect(true).toBe(true)
  })
})
