describe('each', () => {
  it.each([
    [1, 1, 2],
    [2, 2, 4],
    [3, 3, 7],
  ])('adds %i and %i', (a: number, b: number, sum: number) => {
    expect(a + b).toBe(sum)
  })

  it.each`
    a    | b    | sum
    ${1} | ${2} | ${3}
    ${2} | ${3} | ${5}
  `('template $a + $b', ({ a, b, sum }: { a: number; b: number; sum: number }) => {
    expect(a + b).toBe(sum)
  })
})
