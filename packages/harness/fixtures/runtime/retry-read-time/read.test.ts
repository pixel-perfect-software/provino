jest.retryTimes(1)

const calls: Record<string, number> = {}

/** A test body that fails every time and traces every call. */
function failing(name: string): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    throw new Error(`${name} failed #${calls[name]}`)
  }
}

test('root test', failing('root'))

describe('beforeAll lowers it', () => {
  beforeAll(() => {
    jest.retryTimes(0)
  })
  test('lowered', failing('lowered'))
})

describe('beforeAll raises it', () => {
  beforeAll(() => {
    jest.retryTimes(2)
  })
  test('raised', failing('raised'))
})

describe('a test body sets it', () => {
  test('sets it to 3', () => {
    jest.retryTimes(3)
    trace('set 3')
  })
  test('keeps the value from the start of the describe', failing('same describe'))
})

describe('after the call', () => {
  test('uses the value set in the test body', failing('after'))
})
