// A describe.only inside a skipped describe.
describe.skip('skipped describe', () => {
  describe.only('only describe inside it', () => {
    test('a test with no mode', () => {})
  })
})

test('a test outside the skipped describe with a describe.only', () => {})
