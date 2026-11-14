const check = (value) => {
  expect(value).toMatchInlineSnapshot()
}

test('one call, two values', () => {
  check(1)
  check(2)
})
