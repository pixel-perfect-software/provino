// The /jest-globals entry extends the `expect` that @jest/globals serves; each file imports both.
import '@testing-library/jest-dom/jest-globals'
import { beforeEach, expect, test } from '@jest/globals'

beforeEach(() => {
  document.body.innerHTML = '<p id="note" data-file="first">The first file</p>'
})

const note = (): HTMLElement => document.getElementById('note') as HTMLElement

test('first: toBeInTheDocument passes', () => {
  expect(note()).toBeInTheDocument()
})
test('first: toHaveTextContent passes', () => {
  expect(note()).toHaveTextContent('The first file')
})
test('first: toHaveAttribute fails', () => {
  expect(note()).toHaveAttribute('data-file', 'neither')
})
test('first: .not.toBeInTheDocument fails', () => {
  expect(note()).not.toBeInTheDocument()
})
