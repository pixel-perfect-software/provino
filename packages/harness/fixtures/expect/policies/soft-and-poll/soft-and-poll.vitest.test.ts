describe('expect.soft', () => {
  test('two soft failures are both reported at the end', () => {
    expect.soft(1).toBe(2)
    expect.soft('a').toBe('b')
  })

  test('a soft failure then a passing hard assertion', () => {
    expect.soft(1).toBe(2)
    expect(1).toBe(1)
  })

  test('a soft failure then a failing hard assertion stops the test', () => {
    expect.soft(1).toBe(2)
    expect(2).toBe(3)
    expect.soft(3).toBe(4)
  })

  test('soft assertions that all pass', () => {
    expect.soft(1).toBe(1)
    expect.soft({ a: 1 }).toEqual({ a: 1 })
  })
})

describe('expect.poll', () => {
  test('poll passes on its third call', async () => {
    let calls = 0
    await expect.poll(() => ++calls, { interval: 20, timeout: 1000 }).toBe(3)
  })

  test('poll rejects after its timeout', async () => {
    await expect.poll(() => 'pending', { interval: 20, timeout: 100 }).toBe('done')
  })

  test('unawaited poll', () => {
    expect.poll(() => 1).toBe(1)
  })
})
