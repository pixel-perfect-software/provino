// The larger file, so a runner with no history runs it first.
describe('the setup file’s server', () => {
  it('answers the handled request', async () => {
    const response = await fetch('https://api.example.invalid/user')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'ada' })
  })

  it('passes an unhandled request through, which fails to connect', async () => {
    await expect(fetch('https://api.example.invalid/users-unhandled')).rejects.toThrow()
  })
})
