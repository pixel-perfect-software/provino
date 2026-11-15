class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

describe('calls', () => {
  it('passes toThrowWithMessage and toHaveBeenCalledBefore', () => {
    const first = jest.fn()
    const second = jest.fn()
    first()
    second()
    expect(first).toHaveBeenCalledBefore(second)
    expect(second).not.toHaveBeenCalledBefore(first)
    expect(() => {
      throw new ValidationError('bad input')
    }).toThrowWithMessage(ValidationError, 'bad input')
    expect(() => {
      throw new ValidationError('bad input')
    }).toThrowWithMessage(ValidationError, /bad/)
  })

  it('passes pass()', () => {
    expect(undefined).pass('always')
  })

  it('fails toHaveBeenCalledBefore', () => {
    const first = jest.fn()
    const second = jest.fn()
    second()
    first()
    expect(first).toHaveBeenCalledBefore(second)
  })

  it('fails toThrowWithMessage', () => {
    expect(() => {
      throw new ValidationError('other text')
    }).toThrowWithMessage(ValidationError, 'bad input')
  })

  it('fails fail()', () => {
    expect(undefined).fail('told to fail')
  })
})
