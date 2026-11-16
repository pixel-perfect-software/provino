// An effect's cleanup sets a timer that reads `window` after RTL's afterEach(cleanup) unmounts the
// component, as an editor binding that destroys its view a tick after unmount does.
import { render, screen } from '@testing-library/react'
import { createElement, useEffect } from 'react'

function Editor() {
  useEffect(
    () => () => {
      setTimeout(() => {
        window.getComputedStyle(document.body)
      }, 20)
    },
    [],
  )
  return createElement('p', null, 'editor')
}

test('unmount-timer: the component renders', () => {
  render(createElement(Editor))
  expect(screen.getByText('editor').tagName).toBe('P')
})
