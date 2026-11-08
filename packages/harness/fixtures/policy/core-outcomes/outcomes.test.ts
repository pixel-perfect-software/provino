// Edge cases whose result the golden records: the policy-truth claims read the tests' statuses
// and errors.
const api = test as unknown as Record<string, typeof test>
const failing = typeof jest === 'undefined' ? api.fails : api.failing

test.each([])('an empty table %s', () => {})

test('throws before any assertion', () => {
  expect.hasAssertions()
  throw new Error('thrown first')
})

describe('a beforeEach that throws', () => {
  beforeEach(() => {
    throw new Error('beforeEach failed')
  })
  failing?.('an expected failure whose body passes', () => {})
})

describe.skip('a skipped describe', () => {
  test.todo('a todo inside it')
})

test('a passing test, so the file runs', () => {})
