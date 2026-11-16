test('b is running when the timer fires', async () => {
  await new Promise((resolve) => setTimeout(resolve, 800))
})

test('b fails on its own', () => {
  throw new Error('the second file fails anyway')
})
