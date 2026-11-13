// A test that leaves an interval running after the file is done: without --forceExit the runner
// would wait on it. The interval is unref'd by nothing, on purpose.
test('leaks an interval', () => {
  setInterval(() => {}, 1000)
})
