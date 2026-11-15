// The same import in a second file on the same worker: is its afterEach(cleanup) registered again?
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'

test('second: the first render', () => {
  expect(document.body.innerHTML).toBe('')
  render(createElement('p', null, 'rendered by second'))
  expect(screen.getByText('rendered by second').tagName).toBe('P')
})
test('second: a second test starts on an empty body', () => {
  expect(document.body.innerHTML).toBe('')
  render(createElement('p', null, 'again in second'))
  expect(screen.getAllByText(/in second/)).toHaveLength(1)
})
test('second: getByText fails with the DOM dump', () => {
  expect(document.body.innerHTML).toBe('')
  render(
    createElement(
      'ul',
      { 'data-file': 'second' },
      createElement('li', null, 'one item with a long enough text to be cut by the print limit'),
      createElement('li', null, 'another item'),
    ),
  )
  screen.getByText('not on the page')
})
