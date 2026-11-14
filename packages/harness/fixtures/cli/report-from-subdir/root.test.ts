// A file at the root, above the working directory: Jest prints it as `../root.test.ts`. The
// longest file of the three, so Jest runs it first.
test('root passes', () => {
  expect('a file above the working directory').toBe('a file above the working directory')
})
