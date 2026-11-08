// `jest` is a module-scoped binding under Jest and `vi` a global under Vitest, so one file runs
// under both.
const mocker = typeof jest === 'undefined' ? vi : jest

describe('fake timers', () => {
  afterEach(() => {
    mocker.useRealTimers()
  })

  it('runs a timeout when time advances', () => {
    mocker.useFakeTimers()
    const callback = mocker.fn()
    setTimeout(callback, 1000)
    mocker.advanceTimersByTime(999)
    expect(callback).not.toHaveBeenCalled()
    mocker.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('sets the system time', () => {
    mocker.useFakeTimers()
    mocker.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
    expect(Date.now()).toBe(1577836800000)
    expect(new Date().toISOString()).toBe('2020-01-01T00:00:00.000Z')
  })

  it('runs every pending timer in order', () => {
    mocker.useFakeTimers()
    const order: number[] = []
    setTimeout(() => order.push(2), 20)
    setTimeout(() => order.push(1), 10)
    mocker.runAllTimers()
    expect(order).toEqual([1, 2])
  })
})
