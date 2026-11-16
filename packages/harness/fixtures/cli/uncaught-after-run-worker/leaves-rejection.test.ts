test('leaves a rejection nobody handles', () => {
  void Promise.reject(new Error('rejected as its test ends'))
})
