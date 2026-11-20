// What a happy-dom file sees under Vitest 5.0.5, one observation a test.
test('window, self and globalThis are one object', () => {
  expect(window === globalThis && self === globalThis).toBe(true)
})

test('the default URL is http://localhost:3000/', () => {
  expect(location.href).toBe('http://localhost:3000/')
})

test('a DOM write reads back', () => {
  document.body.innerHTML = '<p id="x">hello</p>'
  expect(document.getElementById('x')?.textContent).toBe('hello')
})

test('the user agent names HappyDOM', () => {
  expect(navigator.userAgent).toMatch(/HappyDOM/)
})

test('environmentOptions.happyDOM.width reaches the window', () => {
  expect(innerWidth).toBe(640)
})

test('Buffer is on the window', () => {
  expect(typeof Buffer).toBe('function')
})
