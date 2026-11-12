const div = document.createElement('div')

test('a div is an instance of Object', () => {
  expect(div instanceof Object).toBe(true)
})
test('a div is an instance of Node, Element and HTMLElement', () => {
  expect(div instanceof Node).toBe(true)
  expect(div instanceof Element).toBe(true)
  expect(div instanceof HTMLElement).toBe(true)
})
test('a div is an instance of its own constructor', () => {
  expect(div instanceof HTMLDivElement).toBe(true)
  expect(Object.getPrototypeOf(div)).toBe(HTMLDivElement.prototype)
})
test('an array literal is an instance of Array', () => {
  // biome-ignore lint/suspicious/useIsArray: the check under test is `instanceof`
  expect([] instanceof Array).toBe(true)
})
test('an object literal is an instance of Object', () => {
  expect({} instanceof Object).toBe(true)
})
test('an Error is an instance of Error', () => {
  expect(new Error('x') instanceof Error).toBe(true)
})
test('JSON.parse gives an instance of Object', () => {
  expect(JSON.parse('{}') instanceof Object).toBe(true)
})
test('an Event made in the test is an instance of Event', () => {
  expect(new Event('x') instanceof Event).toBe(true)
})
test('window.Object is the global Object', () => {
  expect(window.Object).toBe(Object)
})
