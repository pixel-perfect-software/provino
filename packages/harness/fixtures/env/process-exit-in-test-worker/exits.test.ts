// The larger file, so it runs first.
test('calls process.exit', () => {
  process.exit(3)
})

test('runs after the exit', () => {})
