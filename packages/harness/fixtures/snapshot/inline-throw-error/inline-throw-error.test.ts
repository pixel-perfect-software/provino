test('new thrown messages', () => {
  expect(() => {
    throw new Error('first')
  }).toThrowErrorMatchingInlineSnapshot()
  expect(() => {
    throw new Error('outer', { cause: new Error('inner') })
  }).toThrowErrorMatchingInlineSnapshot()
})

test('a message that changed', () => {
  expect(() => {
    throw new TypeError('changed')
  }).toThrowErrorMatchingInlineSnapshot(`"old"`)
})
