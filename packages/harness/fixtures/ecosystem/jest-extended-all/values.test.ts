describe('values', () => {
  it('passes toBeOneOf, toIncludeSameMembers, toSatisfy and toContainEntry', () => {
    expect(2).toBeOneOf([1, 2, 3])
    expect([1, { a: 2 }, 3]).toIncludeSameMembers([3, 1, { a: 2 }])
    expect(4).toSatisfy((n: number) => n % 2 === 0)
    expect({ a: 1, b: { c: 2 } }).toContainEntry(['b', { c: 2 }])
    expect(5).not.toBeOneOf([1, 2, 3])
    expect({ pick: 'b' }).toEqual({ pick: expect.toBeOneOf(['a', 'b']) })
    expect({ pick: 'z' }).toEqual({ pick: expect.not.toBeOneOf(['a', 'b']) })
  })

  it('fails toBeOneOf', () => {
    expect(4).toBeOneOf([1, 2, 3])
  })

  it('fails toIncludeSameMembers', () => {
    expect([1, 2, 2]).toIncludeSameMembers([1, 2, 3])
  })

  it('fails toSatisfy', () => {
    expect(3).toSatisfy(function isEven(n: number) {
      return n % 2 === 0
    })
  })

  it('fails toContainEntry', () => {
    expect({ a: 1 }).toContainEntry(['a', 2])
  })

  it('fails .not.toBeOneOf', () => {
    expect(1).not.toBeOneOf([1, 2])
  })

  it('fails an asymmetric expect.toBeOneOf inside toEqual', () => {
    expect({ pick: 'c' }).toEqual({ pick: expect.toBeOneOf(['a', 'b']) })
  })
})
