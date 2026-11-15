// The default `axe`, with the matcher added to this file's `expect`.
import { axe, toHaveNoViolations } from 'jest-axe'

expect.extend(toHaveNoViolations)

test('a labelled form has no violations', async () => {
  document.body.innerHTML =
    '<main><form><label for="name">Name</label><input id="name" type="text"></form></main>'
  expect(await axe(document.body)).toHaveNoViolations()
})
test('an image with no alt is a violation', async () => {
  document.body.innerHTML = '<main><img src="photo.png"></main>'
  expect(await axe(document.body)).toHaveNoViolations()
})
