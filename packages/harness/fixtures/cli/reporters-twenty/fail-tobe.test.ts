describe('toBe', () => {
  it('fails with numbers', () => {
    const received: number = 1
    expect(received).toBe(2)
  })

  it('passes beside it', () => {
    expect('same').toBe('same')
  })
})
