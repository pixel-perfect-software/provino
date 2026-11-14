describe('console', () => {
  it('logs and warns', () => {
    console.log('a log line')
    console.warn('a warning')
    console.error('an error line')
    expect(1).toBe(1)
  })
})
