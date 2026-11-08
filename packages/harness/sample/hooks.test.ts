describe('a failing beforeAll', () => {
  beforeAll(() => {
    throw new Error('beforeAll failed')
  })

  it('first test under it', () => {
    expect(1).toBe(1)
  })

  it('second test under it', () => {
    expect(2).toBe(2)
  })
})

describe('a failing beforeEach', () => {
  beforeEach(() => {
    throw new Error('beforeEach failed')
  })

  it('fails before its body runs', () => {
    expect(1).toBe(1)
  })
})

describe('a failing afterEach', () => {
  afterEach(() => {
    throw new Error('afterEach failed')
  })

  it('fails after its body passed', () => {
    expect(1).toBe(1)
  })
})

describe('passing hooks', () => {
  const calls: string[] = []

  beforeEach(() => {
    calls.push('before')
  })

  afterEach(() => {
    calls.push('after')
  })

  it('runs beforeEach first', () => {
    expect(calls).toEqual(['before'])
  })

  it('ran afterEach after the first test', () => {
    expect(calls).toEqual(['before', 'after', 'before'])
  })
})
