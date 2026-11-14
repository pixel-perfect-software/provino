test('missing', () => {
  expect({ a: 1 }).toMatchInlineSnapshot()
})

test('differs', () => {
  expect('new').toMatchInlineSnapshot(`"old"`)
})

test('matches', () => {
  expect('same').toMatchInlineSnapshot(`"same"`)
})
