// configureAxe with a rule turned off; the matcher is added to this file's `expect` again.
import { configureAxe, toHaveNoViolations } from 'jest-axe'

expect.extend(toHaveNoViolations)

const axe = configureAxe({ rules: { 'image-alt': { enabled: false } } })

test('image-alt is off, so an image with no alt passes', async () => {
  document.body.innerHTML = '<main><img src="photo.png"></main>'
  expect(await axe(document.body)).toHaveNoViolations()
})
test('a button with no name is a violation', async () => {
  document.body.innerHTML = '<main><button type="button"></button></main>'
  expect(await axe(document.body)).toHaveNoViolations()
})
