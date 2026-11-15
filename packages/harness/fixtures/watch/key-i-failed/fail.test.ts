test('first fails', () => {
  expect(1).toBe(2)
})

test('passes', () => {
  expect(1).toBe(1)
})

test('second fails', () => {
  expect(3).toBe(4)
})
