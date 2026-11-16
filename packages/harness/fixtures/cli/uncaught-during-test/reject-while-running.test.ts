test('a rejection nobody handles while the test awaits', async () => {
  void Promise.reject(new Error('rejected while its test runs'))
  await new Promise((resolve) => setTimeout(resolve, 30))
})
