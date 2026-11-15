const { resetAllWhenMocks, verifyAllWhenMocksCalled, when } =
  require('jest-when') as typeof import('jest-when')

describe('verifyAllWhenMocksCalled', () => {
  it('fails on the when-mocks no call reached', () => {
    const called = jest.fn()
    const uncalled = jest.fn()
    when(called).calledWith('a').mockReturnValue(1)
    // jest-when keeps the stack below its own three frames as the mock's call site, and prints it
    // in the failure: four frames leave only this line, not the runner's machine paths.
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 4
    try {
      when(uncalled).calledWith('b').mockReturnValue(2)
    } finally {
      Error.stackTraceLimit = limit
    }
    expect(called('a')).toBe(1)
    verifyAllWhenMocksCalled()
  })

  it('passes after resetAllWhenMocks', () => {
    resetAllWhenMocks()
    const fn = jest.fn()
    when(fn).calledWith('c').mockReturnValue(3)
    expect(fn('c')).toBe(3)
    verifyAllWhenMocksCalled()
  })
})
