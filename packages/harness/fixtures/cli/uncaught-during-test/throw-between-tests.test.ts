test('a schedules a timer and ends first', () => {
  setTimeout(() => {
    throw new Error('thrown between tests')
  }, 0)
})

describe('later', () => {
  beforeAll(() => new Promise((resolve) => setTimeout(resolve, 30)))

  test('b starts after the timer fired', () => {})
})
