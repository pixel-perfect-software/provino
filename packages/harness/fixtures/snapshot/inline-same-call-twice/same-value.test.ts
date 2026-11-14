const same = () => {
  expect('again').toMatchInlineSnapshot()
}

test('one call, the same value twice', () => {
  same()
  same()
})
