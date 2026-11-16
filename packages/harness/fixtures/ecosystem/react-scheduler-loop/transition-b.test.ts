// A transition render of a slow list, left to the scheduler when the test ends: the test waits
// while the scheduler's loop runs a few slices, so the slice pending at the end was scheduled from
// the scheduler's own callback, and the render is still running when the window closes; its
// commit's passive-effect flush reads `window.event`.
// The larger of the two, so it runs first.
import { createElement, startTransition, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

/** Takes about 0.2 ms to render, so 2,000 of them span many of the scheduler's 5 ms slices. */
function Row({ index }: { index: number }) {
  const until = performance.now() + 0.2
  while (performance.now() < until) {
    // Busy: the render's time is the point.
  }
  return createElement('li', null, `row ${index}`)
}

function List() {
  useEffect(() => {
    document.title = 'listed'
  }, [])
  const rows = []
  for (let index = 0; index < 2000; index++) rows.push(createElement(Row, { key: index, index }))
  return createElement('ul', null, rows)
}

test('transition-b: the render is left to the scheduler mid-flight', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  startTransition(() => {
    root.render(createElement(List))
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(container.innerHTML).toBe('')
})
