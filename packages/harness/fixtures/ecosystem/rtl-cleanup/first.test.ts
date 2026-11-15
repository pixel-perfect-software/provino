// RTL's import registers afterEach(cleanup): every test here asserts that it starts on an empty body.
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'

test('first: the first render', () => {
  expect(document.body.innerHTML).toBe('')
  render(createElement('p', null, 'rendered by first'))
  expect(screen.getByText('rendered by first').tagName).toBe('P')
})
test('first: a second test starts on an empty body', () => {
  expect(document.body.innerHTML).toBe('')
  render(createElement('p', null, 'again in first'))
  expect(screen.getAllByText(/in first/)).toHaveLength(1)
})
test('first: getByText fails with the DOM dump', () => {
  expect(document.body.innerHTML).toBe('')
  render(
    createElement(
      'ul',
      { 'data-file': 'first' },
      createElement('li', null, 'one item with a long enough text to be cut by the print limit'),
      createElement('li', null, 'another item'),
    ),
  )
  screen.getByText('not on the page')
})
