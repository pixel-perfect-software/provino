// The jest.fn twin is spies.jest.test.ts: keep the titles and the order the same.
describe('called', () => {
  test('toHaveBeenCalled a mock that was never called', () => {
    const fn = vi.fn()
    expect(fn).toHaveBeenCalled()
  })

  test('not.toHaveBeenCalled a mock that was called', () => {
    const fn = vi.fn()
    fn('a', 1)
    expect(fn).not.toHaveBeenCalled()
  })

  test('toHaveBeenCalled a named mock', () => {
    const fn = vi.fn().mockName('fetchUser')
    expect(fn).toHaveBeenCalled()
  })

  test('toHaveBeenCalled a spyOn method', () => {
    const calculator = { add: (a: number, b: number): number => a + b }
    const spy = vi.spyOn(calculator, 'add')
    expect(spy).toHaveBeenCalled()
  })

  test('toHaveBeenCalledTimes a wrong count', () => {
    const fn = vi.fn()
    fn()
    fn()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  test('not.toHaveBeenCalledTimes the actual count', () => {
    const fn = vi.fn()
    fn()
    expect(fn).not.toHaveBeenCalledTimes(1)
  })
})

describe('called with', () => {
  test('toHaveBeenCalledWith other arguments', () => {
    const fn = vi.fn()
    fn(1, 'two')
    expect(fn).toHaveBeenCalledWith(1, 'three')
  })

  test('toHaveBeenCalledWith lists every call', () => {
    const fn = vi.fn()
    fn({ id: 1 })
    fn({ id: 2 })
    expect(fn).toHaveBeenCalledWith({ id: 3 })
  })

  test('toHaveBeenCalledWith a mock that was never called', () => {
    const fn = vi.fn()
    expect(fn).toHaveBeenCalledWith('x')
  })

  test('not.toHaveBeenCalledWith the arguments it got', () => {
    const fn = vi.fn()
    fn(1)
    expect(fn).not.toHaveBeenCalledWith(1)
  })

  test('toHaveBeenLastCalledWith the first call arguments', () => {
    const fn = vi.fn()
    fn('first')
    fn('second')
    expect(fn).toHaveBeenLastCalledWith('first')
  })

  test('toHaveBeenNthCalledWith the wrong call', () => {
    const fn = vi.fn()
    fn('a')
    fn('b')
    expect(fn).toHaveBeenNthCalledWith(2, 'a')
  })
})

describe('returned', () => {
  test('toHaveReturned a mock that only threw', () => {
    const fn = vi.fn((): number => {
      throw new Error('no value')
    })
    try {
      fn()
    } catch {
      // The throw is the setup; the assertion below is the case.
    }
    expect(fn).toHaveReturned()
  })

  test('not.toHaveReturned a mock that returned', () => {
    const fn = vi.fn(() => 7)
    fn()
    expect(fn).not.toHaveReturned()
  })

  test('toHaveReturnedTimes a wrong count', () => {
    const fn = vi.fn(() => 1)
    fn()
    expect(fn).toHaveReturnedTimes(2)
  })

  test('toHaveReturnedWith another value', () => {
    const fn = vi.fn((n: number) => n * 2)
    fn(2)
    expect(fn).toHaveReturnedWith(5)
  })

  test('not.toHaveReturnedWith a value it returned', () => {
    const fn = vi.fn((n: number) => n * 2)
    fn(2)
    expect(fn).not.toHaveReturnedWith(4)
  })

  test('toHaveLastReturnedWith the first return value', () => {
    const fn = vi.fn((n: number) => n * 2)
    fn(1)
    fn(2)
    expect(fn).toHaveLastReturnedWith(2)
  })

  test('toHaveNthReturnedWith the wrong return', () => {
    const fn = vi.fn((n: number) => n * 2)
    fn(1)
    fn(2)
    expect(fn).toHaveNthReturnedWith(1, 4)
  })
})
