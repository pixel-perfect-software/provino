const missing = require('./does-not-exist')

describe('never reached', () => {
  it('does not run', () => {
    expect(missing).toBeDefined()
  })
})
