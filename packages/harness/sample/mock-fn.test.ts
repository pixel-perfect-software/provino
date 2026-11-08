// `jest` is a module-scoped binding under Jest and `vi` a global under Vitest, so one file runs
// under both.
const mocker = typeof jest === 'undefined' ? vi : jest

describe('mock functions', () => {
  it('records calls', () => {
    const f = mocker.fn()
    f(1, 'a')
    expect(f).toHaveBeenCalledWith(1, 'a')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns a value', () => {
    const f = mocker.fn().mockReturnValue(7)
    expect(f()).toBe(7)
  })

  it('uses an implementation', () => {
    const f = mocker.fn((n: number) => n * 2)
    expect(f(4)).toBe(8)
    expect(f.mock.calls).toEqual([[4]])
  })

  it('fails a call assertion', () => {
    const f = mocker.fn()
    f(1)
    expect(f).toHaveBeenCalledWith(2)
  })

  it('fails a call count', () => {
    const f = mocker.fn()
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('spyOn', () => {
  it('replaces a method and restores it', () => {
    const greeter = { greet: (name: string) => `hi ${name}` }
    const spy = mocker.spyOn(greeter, 'greet').mockReturnValue('mocked')
    expect(greeter.greet('you')).toBe('mocked')
    expect(spy).toHaveBeenCalledWith('you')
    spy.mockRestore()
    expect(greeter.greet('you')).toBe('hi you')
  })

  it('watches a method without replacing it', () => {
    const counter = { next: (n: number) => n + 1 }
    const spy = mocker.spyOn(counter, 'next')
    expect(counter.next(1)).toBe(2)
    expect(spy).toHaveReturnedWith(2)
  })
})

describe('mockReset', () => {
  it('leaves a function that returns undefined', () => {
    const f = mocker.fn(() => 'implementation')
    f.mockReset()
    expect(f()).toBeUndefined()
  })
})
