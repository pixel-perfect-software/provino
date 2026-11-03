const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('expect.assertions', () => {
  test('assertions(2) met', () => {
    expect.assertions(2)
    expect(1).toBe(1)
    expect(2).toBe(2)
  })

  test('assertions(2) missed with one made', () => {
    expect.assertions(2)
    expect(1).toBe(1)
  })

  test('assertions(1) exceeded with two made', () => {
    expect.assertions(1)
    expect(1).toBe(1)
    expect(2).toBe(2)
  })

  test('assertions(0) with none made', () => {
    expect.assertions(0)
  })

  test('assertions(3) counted across awaits', async () => {
    expect.assertions(3)
    expect(1).toBe(1)
    await sleep(20)
    expect(2).toBe(2)
    await expect(Promise.resolve(3)).resolves.toBe(3)
  })

  test('assertions(2) missed after a failed assertion', () => {
    expect.assertions(2)
    expect(1).toBe(2)
  })
})

describe('expect.hasAssertions', () => {
  test('hasAssertions with none made', () => {
    expect.hasAssertions()
  })

  test('hasAssertions with one made', () => {
    expect.hasAssertions()
    expect(true).toBe(true)
  })

  test('hasAssertions with one made after an await', async () => {
    expect.hasAssertions()
    await sleep(20)
    expect(true).toBe(true)
  })
})
