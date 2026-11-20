// What a jsdom file sees under Vitest 5.0.5, one observation a test.
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

test('the user agent names jsdom', () => {
  expect(navigator.userAgent).toMatch(/jsdom/)
})

test('Buffer and fetch are there', () => {
  expect([typeof Buffer, typeof fetch, typeof Request, typeof AbortController]).toEqual([
    'function',
    'function',
    'function',
    'function',
  ])
})

test('document.defaultView is the global', () => {
  expect(document.defaultView === globalThis).toBe(true)
})
