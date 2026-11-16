/** @jest-environment jsdom */
// A jsdom file: the timer it sets through the package reads `window`, and is still pending when
// the file ends.
import { later } from 'later-timer'

test('window-leaves: sets a timer that reads window', () => {
  later(() => {
    window.getComputedStyle(document.body)
  }, 50)
})
