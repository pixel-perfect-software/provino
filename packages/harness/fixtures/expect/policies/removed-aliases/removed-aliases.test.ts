// One file for both runners, so each alias has one test key: Jest has no `vi` global and Vitest
// no `jest`, so the mock factory is whichever exists. Fixture types are stripped, never checked.
const mockFn = typeof vi === 'undefined' ? jest.fn : vi.fn

const calledWithAThenB = () => {
  const fn = mockFn()
  fn('a')
  fn('b')
  return fn
}

const returnedOneThenTwo = () => {
  const fn = mockFn((n: number) => n)
  fn(1)
  fn(2)
  return fn
}

describe('aliases removed in Jest 30', () => {
  test('toBeCalled', () => {
    expect(calledWithAThenB()).toBeCalled()
  })

  test('toBeCalledTimes', () => {
    expect(calledWithAThenB()).toBeCalledTimes(2)
  })

  test('toBeCalledWith', () => {
    expect(calledWithAThenB()).toBeCalledWith('a')
  })

  test('lastCalledWith', () => {
    expect(calledWithAThenB()).lastCalledWith('b')
  })

  test('nthCalledWith', () => {
    expect(calledWithAThenB()).nthCalledWith(1, 'a')
  })

  test('toReturn', () => {
    expect(returnedOneThenTwo()).toReturn()
  })

  test('toReturnTimes', () => {
    expect(returnedOneThenTwo()).toReturnTimes(2)
  })

  test('toReturnWith', () => {
    expect(returnedOneThenTwo()).toReturnWith(1)
  })

  test('lastReturnedWith', () => {
    expect(returnedOneThenTwo()).lastReturnedWith(2)
  })

  test('nthReturnedWith', () => {
    expect(returnedOneThenTwo()).nthReturnedWith(1, 1)
  })

  test('toThrowError', () => {
    expect(() => {
      throw new Error('boom')
    }).toThrowError('boom')
  })

  test('toHaveBeenCalled is the control', () => {
    expect(calledWithAThenB()).toHaveBeenCalled()
  })
})
