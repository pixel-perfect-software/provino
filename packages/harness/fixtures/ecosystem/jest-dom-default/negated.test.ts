// The same matchers under `.not`, in a second file on the same worker.
beforeEach(() => {
  document.body.innerHTML =
    '<button id="go" class="primary" aria-label="Go" style="visibility: hidden">Go now</button>'
})

const go = (): HTMLElement => document.getElementById('go') as HTMLElement

test('.not.toBeInTheDocument passes', () => {
  expect(document.createElement('p')).not.toBeInTheDocument()
})
test('.not.toBeInTheDocument fails', () => {
  expect(go()).not.toBeInTheDocument()
})
test('.not.toHaveClass passes', () => {
  expect(go()).not.toHaveClass('secondary')
})
test('.not.toHaveClass fails', () => {
  expect(go()).not.toHaveClass('primary')
})
test('.not.toHaveTextContent passes', () => {
  expect(go()).not.toHaveTextContent('Stop')
})
test('.not.toHaveTextContent fails', () => {
  expect(go()).not.toHaveTextContent('Go now')
})
test('.not.toBeVisible passes on visibility: hidden', () => {
  expect(go()).not.toBeVisible()
})
test('.not.toBeVisible fails', () => {
  go().style.visibility = 'visible'
  expect(go()).not.toBeVisible()
})
test('.not.toHaveStyle passes', () => {
  expect(go()).not.toHaveStyle({ visibility: 'visible' })
})
test('.not.toHaveStyle fails', () => {
  expect(go()).not.toHaveStyle({ visibility: 'hidden' })
})
test('.not.toHaveAttribute passes', () => {
  expect(go()).not.toHaveAttribute('disabled')
})
test('.not.toHaveAttribute fails', () => {
  expect(go()).not.toHaveAttribute('aria-label', 'Go')
})
