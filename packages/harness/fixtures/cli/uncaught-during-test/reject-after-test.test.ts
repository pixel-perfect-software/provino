test('a schedules a rejection and ends first', () => {
  setTimeout(() => {
    void Promise.reject(new Error('rejected after its test ended'))
  }, 0)
})

test('b is running when the rejection is made', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})
