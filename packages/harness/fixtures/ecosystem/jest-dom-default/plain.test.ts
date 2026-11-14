// The default entry extends Jest's `expect` from `setupFilesAfterEnv`, so no import is needed here.
beforeEach(() => {
  document.body.innerHTML =
    '<div id="box" class="card big" title="greeting" style="color: red; display: block">Hello world</div>' +
    '<span id="hidden" style="display: none">secret</span>'
})

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

test('toBeInTheDocument passes', () => {
  expect(byId('box')).toBeInTheDocument()
})
test('toBeInTheDocument fails on a detached node', () => {
  expect(document.createElement('p')).toBeInTheDocument()
})
test('toHaveClass passes', () => {
  expect(byId('box')).toHaveClass('card', 'big')
})
test('toHaveClass fails', () => {
  expect(byId('box')).toHaveClass('small')
})
test('toHaveTextContent passes', () => {
  expect(byId('box')).toHaveTextContent(/hello/i)
})
test('toHaveTextContent fails', () => {
  expect(byId('box')).toHaveTextContent('Goodbye')
})
test('toBeVisible passes', () => {
  expect(byId('box')).toBeVisible()
})
test('toBeVisible fails on display: none', () => {
  expect(byId('hidden')).toBeVisible()
})
test('toHaveStyle passes', () => {
  expect(byId('box')).toHaveStyle({ color: 'rgb(255, 0, 0)', display: 'block' })
})
test('toHaveStyle fails', () => {
  expect(byId('box')).toHaveStyle('color: blue')
})
test('toHaveAttribute passes', () => {
  expect(byId('box')).toHaveAttribute('title', 'greeting')
})
test('toHaveAttribute fails', () => {
  expect(byId('box')).toHaveAttribute('title', 'farewell')
})
