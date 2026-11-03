class ValidationError extends Error {
  name = 'ValidationError'
}

class CodedError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const throwsBadInput = (): never => {
  throw new Error('bad input')
}

describe('toThrow', () => {
  test('toThrow a function that does not throw', () => {
    expect(() => 1).toThrow()
  })

  test('toThrow a message string that is not in the message', () => {
    expect(throwsBadInput).toThrow('timeout')
  })

  test('toThrow a regex that does not match the message', () => {
    expect(throwsBadInput).toThrow(/^timeout/)
  })

  test('toThrow another error class', () => {
    expect(() => {
      throw new TypeError('wrong type')
    }).toThrow(ValidationError)
  })

  test('toThrow an error object with another message', () => {
    expect(throwsBadInput).toThrow(new Error('other message'))
  })

  test('toThrow an asymmetric matcher that does not match', () => {
    expect(() => {
      throw new CodedError('coded', 'E2')
    }).toThrow(expect.objectContaining({ code: 'E1' }))
  })

  test('toThrow a message when a string is thrown', () => {
    expect(() => {
      throw 'a string'
    }).toThrow('other')
  })

  test('toThrow with a non-function received is a matcher error', () => {
    expect(1).toThrow()
  })

  test('not.toThrow shows the thrown error and its stack', () => {
    expect(throwsBadInput).not.toThrow()
  })

  test('not.toThrow a matching message', () => {
    expect(throwsBadInput).not.toThrow('bad')
  })

  test('not.toThrow a matching class', () => {
    expect(() => {
      throw new ValidationError('invalid')
    }).not.toThrow(ValidationError)
  })
})
