test('inline', () => {
  expect('extra long string oh my gerd').toMatchTrimmedInlineSnapshot()
})

test('inline beside toMatchSnapshot', () => {
  expect('first').toMatchSnapshot()
  expect('second, trimmed and more').toMatchTrimmedInlineSnapshot()
})
