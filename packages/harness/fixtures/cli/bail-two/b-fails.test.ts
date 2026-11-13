// The second file to run: one failing test, which makes two. The count reaches --bail=2 here.
// Padding, so that this file is larger than the third and smaller than the first.
test('b fails', () => {
  throw new Error('failed b')
})
