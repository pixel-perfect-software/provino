afterAll(() => new Promise((resolve) => setTimeout(resolve, 30)))

test('the last test schedules a timer and ends first', () => {
  setTimeout(() => {
    throw new Error('thrown after the last test')
  }, 0)
})
