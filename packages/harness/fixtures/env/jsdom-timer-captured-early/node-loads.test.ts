// The largest file, so it runs first: a node file, which loads the package before any window
// exists, so the package keeps the timer of a node file. In Jest the jsdom file after it evaluates
// the package again, in its own window, so the timer it sets there is the window's.
import { later } from 'later-timer'

test('node-loads: the package loads in a node file', () => {
  expect(typeof later).toBe('function')
})
