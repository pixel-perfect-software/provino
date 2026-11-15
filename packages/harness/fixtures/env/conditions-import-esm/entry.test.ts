// Each title is the entry the edge got.
import entry from 'dual'
import { helperEntry } from './helper.ts'

test(`the test file's import resolves to ${entry}`, () => {
  expect(typeof entry).toBe('string')
})
test(`the helper's import resolves to ${helperEntry}`, () => {
  expect(typeof helperEntry).toBe('string')
})
