// A variable specifier: the alias is `moduleNameMapper`'s, which the boundary check can't resolve.
const alias = '@app/render'
const render = require(alias) as (text: string) => string

test('the project environment is jsdom, with a window that is the global', () => {
  expect(typeof document).toBe('object')
  expect(window.document).toBe(document)
  expect(typeof navigator.userAgent).toBe('string')
})
test('a module reached through the mapper writes to the DOM', () => {
  expect(render('hello')).toBe('<p>hello</p>')
})
test('the DOM is fresh for each file, and a test sees its own writes', () => {
  document.body.innerHTML = ''
  expect(render('again')).toBe('<p>again</p>')
})
test('the default url', () => {
  expect(location.href).toBe('http://localhost/')
})
test('an event reaches a listener', () => {
  const seen: string[] = []
  document.addEventListener('ping', (event) => seen.push(event.type))
  document.dispatchEvent(new Event('ping'))
  expect(seen).toEqual(['ping'])
})
