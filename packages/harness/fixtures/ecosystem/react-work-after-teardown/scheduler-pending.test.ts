// A root rendered outside act: React's scheduler is left the render, and after its commit a
// passive-effect flush that reads `window.event`, when the test has already ended.
import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

function Counter() {
  useEffect(() => {
    document.title = 'counted'
  }, [])
  return createElement('output', null, 'count')
}

test('scheduler-pending: the render is left to the scheduler', () => {
  const container = document.createElement('div')
  document.body.append(container)
  createRoot(container).render(createElement(Counter))
  expect(container.innerHTML).toBe('')
})
