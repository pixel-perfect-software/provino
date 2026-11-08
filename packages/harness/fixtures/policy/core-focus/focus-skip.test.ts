// A test.only inside a skipped describe.
describe.skip('skipped describe', () => {
  test.only('a test.only inside it', () => {})
})

test('a test outside the skipped describe with a test.only', () => {})
