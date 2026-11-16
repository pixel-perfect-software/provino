import { classes } from 'styled-pkg'

test('the package gets what the claiming transform made of its stylesheet', () => {
  expect(classes).toEqual({ title: 'title', box: 'box' })
})
