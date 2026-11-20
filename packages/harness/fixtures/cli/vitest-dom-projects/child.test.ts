// A child project's own environment under `vitest --dom`.
test('the user agent names jsdom', () => {
  expect(navigator.userAgent).toMatch(/jsdom/)
})

test('the user agent does not name HappyDOM', () => {
  expect(navigator.userAgent).not.toMatch(/HappyDOM/)
})
