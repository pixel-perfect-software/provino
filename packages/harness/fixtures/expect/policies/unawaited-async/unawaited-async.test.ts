const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('unawaited async assertions', () => {
  test('unawaited resolves that would pass', () => {
    expect(Promise.resolve(1)).resolves.toBe(1)
  })

  test('unawaited rejects that would pass', () => {
    expect(Promise.reject(new Error('gone'))).rejects.toThrow('gone')
  })

  test('unawaited resolves that fails while the test waits', async () => {
    expect(Promise.resolve(1)).resolves.toBe(2)
    await sleep(50)
  })

  test('unawaited rejects that fails while the test waits', async () => {
    expect(Promise.resolve(1)).rejects.toBe(1)
    await sleep(50)
  })

  test('awaited resolves that passes', async () => {
    await expect(Promise.resolve(1)).resolves.toBe(1)
  })
})
