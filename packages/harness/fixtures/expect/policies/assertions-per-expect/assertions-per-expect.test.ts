/** A matcher that throws an error that is no assertion failure. */
interface Exploding {
  toExplode(): void
}

expect.extend({
  toExplode() {
    throw new TypeError('the matcher blew up')
  },
})

describe('assertions per expect', () => {
  test('a bare expect, with assertions(1)', () => {
    expect.assertions(1)
    expect(1)
  })

  test('one expect reused for two matchers, with assertions(2)', () => {
    expect.assertions(2)
    const assertion = expect(1)
    assertion.toBe(1)
    assertion.toBe(1)
  })

  test('a matcher that throws a TypeError, caught, with assertions(1)', () => {
    expect.assertions(1)
    try {
      ;(expect(1) as unknown as Exploding).toExplode()
    } catch {}
  })
})
