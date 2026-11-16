const { sum } = require('./src/sum.ts') as { sum: (a: number, b: number) => number }

describe('sum', () => {
  it('adds', () => {
    expect(sum(1, 2)).toBe(3)
  })
  it('adds negatives', () => {
    expect(sum(-1, -2)).toBe(-3)
  })
})
