import { describe, expect, it, jest } from '@jest/globals'

const g = globalThis as Record<string, unknown>

describe('with injectGlobals false', () => {
  it('has no test globals', () => {
    expect(typeof g.test).toBe('undefined')
    expect(typeof g.expect).toBe('undefined')
    expect(typeof g.describe).toBe('undefined')
  })
  it('has no jest global', () => {
    expect(typeof g.jest).toBe('undefined')
  })
  it('still has the facade', () => {
    expect(jest.fn(() => 1)()).toBe(1)
  })
})
