test('a schedules a timer and ends first', () => {
  setTimeout(() => {
    throw new Error('thrown after its test ended')
  }, 0)
})

test('b is running when the timer fires', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})
