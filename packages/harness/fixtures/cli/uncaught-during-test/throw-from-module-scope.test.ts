setTimeout(() => {
  throw new Error('thrown by a timer no test owns')
}, 0)

test('the test is running when the timer fires', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})
