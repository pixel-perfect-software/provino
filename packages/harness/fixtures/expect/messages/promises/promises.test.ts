describe('resolves', () => {
  test('resolves.toBe a wrong value', async () => {
    await expect(Promise.resolve(1)).resolves.toBe(2)
  })

  test('resolves.toEqual a wrong object', async () => {
    await expect(Promise.resolve({ id: 1 })).resolves.toEqual({ id: 2 })
  })

  test('resolves when the promise rejected', async () => {
    await expect(Promise.reject(new Error('rejected'))).resolves.toBe(1)
  })

  test('resolves with a non-promise received is a matcher error', async () => {
    await expect(5).resolves.toBe(5)
  })

  test('resolves.not.toBe the resolved value', async () => {
    await expect(Promise.resolve(3)).resolves.not.toBe(3)
  })
})

describe('rejects', () => {
  test('rejects.toThrow a message that is not in the reason', async () => {
    await expect(Promise.reject(new Error('nope'))).rejects.toThrow('yes')
  })

  test('rejects.toEqual a wrong reason', async () => {
    await expect(Promise.reject({ code: 1 })).rejects.toEqual({ code: 2 })
  })

  test('rejects when the promise resolved', async () => {
    await expect(Promise.resolve(5)).rejects.toBe(5)
  })

  test('rejects with a non-promise received is a matcher error', async () => {
    await expect(5).rejects.toBe(5)
  })

  test('rejects.not.toThrow the rejection message', async () => {
    await expect(Promise.reject(new Error('gone'))).rejects.not.toThrow('gone')
  })
})
