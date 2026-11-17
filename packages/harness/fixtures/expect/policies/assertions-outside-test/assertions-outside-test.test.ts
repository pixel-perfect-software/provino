// The module-scope assertion is counted into the file's one state, which the first test to end
// reports.
expect(1).toBe(1)

test('takes the module-scope assertion', () => {
  expect(2).toBe(2)
})

describe('a beforeAll assertion', () => {
  beforeAll(() => {
    expect(3).toBe(3)
  })

  test('assertions(2) is met by the beforeAll one and its own', () => {
    expect.assertions(2)
    expect(4).toBe(4)
  })
})

describe('an afterAll assertion', () => {
  test('ends before the afterAll runs', () => {
    expect(5).toBe(5)
  })

  afterAll(() => {
    expect(6).toBe(6)
  })
})

it.skip('a skipped test ends no test and takes nothing', () => {
  expect(7).toBe(7)
})

it.todo('a todo test ends no test and takes nothing')

describe('after the skipped and todo tests', () => {
  test('takes the afterAll assertion', () => {
    expect(8).toBe(8)
  })
})

describe('hasAssertions in a beforeAll', () => {
  beforeAll(() => {
    expect.hasAssertions()
  })

  test('makes no assertion and fails', () => {})

  test('is not expected to assert', () => {})
})

describe('a retried test', () => {
  let attempts = 0

  beforeAll(() => {
    jest.retryTimes(1)
    expect(9).toBe(9)
  })

  afterAll(() => {
    jest.retryTimes(0)
  })

  test('fails once and then passes', () => {
    attempts++
    expect(10).toBe(10)
    expect(attempts).toBe(2)
  })
})

afterAll(() => {
  expect(11).toBe(11)
})
