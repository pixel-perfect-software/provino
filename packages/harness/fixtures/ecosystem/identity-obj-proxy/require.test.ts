// The larger file, so a runner with no history runs it first.
describe('require of a mapped .css', () => {
  it('reads back each key', () => {
    const styles = require('./a.css') as Record<string, unknown>
    expect(styles.foo).toBe('foo')
    expect(styles['bar-baz']).toBe('bar-baz')
  })

  it('says __esModule is false', () => {
    const styles = require('./a.css') as Record<string, unknown>
    expect(styles.__esModule).toBe(false)
    expect(styles.default).toBe('default')
  })
})
