// What a file sees under `vitest --dom`, one observation a test.
test('there is a document', () => {
  document.body.innerHTML = '<p id="x">hello</p>'
  expect(document.getElementById('x')?.textContent).toBe('hello')
})

test('the user agent names HappyDOM', () => {
  expect(navigator.userAgent).toMatch(/HappyDOM/)
})

test('the default URL is http://localhost:3000/', () => {
  expect(location.href).toBe('http://localhost:3000/')
})
