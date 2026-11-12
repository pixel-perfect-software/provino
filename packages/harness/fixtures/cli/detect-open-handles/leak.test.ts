// A test that leaves an interval running after the file is done.
test('leaks an interval', () => {
  setInterval(() => {}, 1000)
})
