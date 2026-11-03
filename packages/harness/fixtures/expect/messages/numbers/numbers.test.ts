describe('comparisons', () => {
  test('toBeGreaterThan with a smaller received', () => {
    expect(1).toBeGreaterThan(2)
  })

  test('toBeGreaterThanOrEqual with a smaller received', () => {
    expect(1).toBeGreaterThanOrEqual(2)
  })

  test('toBeLessThan with a larger received', () => {
    expect(3).toBeLessThan(2)
  })

  test('toBeLessThanOrEqual with a larger received', () => {
    expect(3).toBeLessThanOrEqual(2)
  })

  test('not.toBeGreaterThan with a larger received', () => {
    expect(3).not.toBeGreaterThan(2)
  })

  test('not.toBeLessThanOrEqual with an equal received', () => {
    expect(2).not.toBeLessThanOrEqual(2)
  })

  test('toBeGreaterThan with bigint operands', () => {
    expect(10n).toBeGreaterThan(20n)
  })

  test('toBeLessThan with a bigint received and a number expected', () => {
    expect(5n).toBeLessThan(3)
  })

  test('toBeGreaterThan with a string received is a matcher error', () => {
    expect('5').toBeGreaterThan(3)
  })
})

describe('toBeCloseTo', () => {
  test('toBeCloseTo with the default precision', () => {
    expect(0.3).toBeCloseTo(0.31)
  })

  test('toBeCloseTo with precision 5', () => {
    expect(0.12345).toBeCloseTo(0.1235, 5)
  })

  test('not.toBeCloseTo with a float sum', () => {
    expect(0.1 + 0.2).not.toBeCloseTo(0.3)
  })

  // Jest rejects the string; Vitest coerces it, so the expected value is out of range for both.
  test('toBeCloseTo with a string received is a matcher error', () => {
    expect('0.3').toBeCloseTo(0.4)
  })
})

describe('toBeNaN', () => {
  test('toBeNaN with a number', () => {
    expect(1).toBeNaN()
  })

  test('not.toBeNaN with NaN', () => {
    expect(Number.NaN).not.toBeNaN()
  })
})
