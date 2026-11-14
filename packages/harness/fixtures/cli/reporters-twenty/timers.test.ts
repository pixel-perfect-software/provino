describe('timers', () => {
  it('advances fake time', () => {
    jest.useFakeTimers()
    const done = jest.fn()
    setTimeout(done, 1000)
    jest.advanceTimersByTime(999)
    expect(done).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })
})
