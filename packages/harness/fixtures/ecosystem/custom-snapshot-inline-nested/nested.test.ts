test('a custom matcher over another', () => {
  expect('loud string, trimmed').toMatchShoutedInlineSnapshot()
})

test('the built-in inside a custom matcher', () => {
  expect('built in').toMatchBuiltInInlineSnapshot()
})

test('the built-in two custom matchers down', () => {
  expect('deeper').toMatchNestedBuiltInInlineSnapshot()
})
