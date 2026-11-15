// The second file on the same worker imports the entry again, as each Jest test file does.
import '@testing-library/jest-dom/jest-globals'
import { beforeEach, expect, test } from '@jest/globals'

beforeEach(() => {
  document.body.innerHTML = '<p id="note" data-file="second">The second file</p>'
})

const note = (): HTMLElement => document.getElementById('note') as HTMLElement

test('second: toBeInTheDocument passes', () => {
  expect(note()).toBeInTheDocument()
})
test('second: toHaveTextContent fails', () => {
  expect(note()).toHaveTextContent('The first file')
})
test('second: toHaveAttribute passes', () => {
  expect(note()).toHaveAttribute('data-file', 'second')
})
test('second: .not.toHaveAttribute fails', () => {
  expect(note()).not.toHaveAttribute('id')
})
