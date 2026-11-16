// An effect sets a timer whose callback updates state, as an icon component that loads its data
// does; the file ends before it fires.
import { render, screen } from '@testing-library/react'
import { createElement, useEffect, useState } from 'react'

function Icon() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    setTimeout(() => setLoaded(true), 20)
  }, [])
  return createElement('span', null, loaded ? 'loaded' : 'loading')
}

test('state-timer: the component renders before its data', () => {
  render(createElement(Icon))
  expect(screen.getByText('loading').tagName).toBe('SPAN')
})
