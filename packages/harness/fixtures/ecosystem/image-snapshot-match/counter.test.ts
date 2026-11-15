import { GREEN, png } from './png.ts'

// One counter per test, shared by both matchers: the image is the test's second snapshot, so
// `toMatchSnapshot` stores `counter 1` and `counter 3`.
test('counter', () => {
  expect('first').toMatchSnapshot()
  expect(png(2, 2, () => GREEN)).toMatchImageSnapshot()
  expect('third').toMatchSnapshot()
})
