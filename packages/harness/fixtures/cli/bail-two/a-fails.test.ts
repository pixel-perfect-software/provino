// The first file to run: one failing test. It is the largest file, because a runner with no
// history for a file starts with the biggest one. Padding follows so that it stays so.
// Padding, so that this file is the largest and runs first.
// Padding, so that this file is the largest and runs first.
// Padding, so that this file is the largest and runs first.
test('a fails', () => {
  throw new Error('failed a')
})
