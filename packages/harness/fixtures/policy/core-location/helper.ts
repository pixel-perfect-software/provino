// Registers a test from outside the test file. The call to `test` is on line 9, column 5, which
// no line of the test file has, so the golden's location says which frame was taken.
//
//
//

export function register(name: string): void {
  if (name !== '') {
    test(name, () => {})
  }
}
