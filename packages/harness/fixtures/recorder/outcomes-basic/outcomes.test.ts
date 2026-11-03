interface Pair {
  readonly left: number
  readonly right: number
}

const sum = (pair: Pair): number => pair.left + pair.right

describe('outcomes', () => {
  it('passes', () => {
    expect(sum({ left: 1, right: 2 })).toBe(3)
  })

  it('fails on toBe', () => {
    expect(sum({ left: 1, right: 2 })).toBe(4)
  })

  it.skip('is skipped', () => {})

  it.todo('is a todo')

  it.each([1, 1])('shares a title', (n: number) => {
    expect(n).toBe(1)
  })

  describe('with a beforeEach that throws', () => {
    beforeEach(() => {
      throw new Error('setup failed')
    })

    it('never gets to run', () => {})

    it('is not run either', () => {})
  })
})
