class CustomError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomError'
  }
}

describe('thrown errors', () => {
  test('messages', () => {
    expect(() => {
      throw new Error('boom')
    }).toThrowErrorMatchingSnapshot()
    expect(() => {
      throw new CustomError('custom')
    }).toThrowErrorMatchingSnapshot('with hint')
    expect(() => {
      throw new TypeError('multi\nline')
    }).toThrowErrorMatchingSnapshot()
  })

  test('causes', () => {
    expect(() => {
      throw new Error('outer', { cause: new Error('inner') })
    }).toThrowErrorMatchingSnapshot()
    expect(() => {
      throw new Error('with a string cause', { cause: 'just text' })
    }).toThrowErrorMatchingSnapshot()
  })

  test('rejections', async () => {
    await expect(Promise.reject(new Error('rejected'))).rejects.toThrowErrorMatchingSnapshot()
    await expect(async () => {
      throw new Error('async function')
    }).rejects.toThrowErrorMatchingSnapshot()
  })
})
