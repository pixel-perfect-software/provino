// Every test takes a few milliseconds, so Jest's verbose list always prints a duration after it.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('r01', tick)
test('r02', tick)
test.skip('r03 skipped', tick)
test.todo('r04 todo')
test.concurrent('c1', tick)
test.concurrent('c2', tick)

describe('alpha', () => {
  test('a1', tick)
  test('a2', tick)
  test('a3', tick)
  test('a4', tick)
})

describe('beta', () => {
  test('b1', tick)
  test('b2', tick)
  describe('beta inner', () => {
    test('i1', tick)
    test('i2', tick)
    test('i3', tick)
  })
  test('b3', tick)
})

describe('gamma', () => {
  test.each([1, 2, 3])('gamma each %i', tick)
  test('g4', tick)
  test('g5', tick)
  test.concurrent('gc1', tick)
  test.concurrent('gc2', tick)
})

describe.skip('delta', () => {
  test('d1', tick)
  test('d2', tick)
})

describe('epsilon', () => {
  beforeAll(() => {})
  test('e1', tick)
  test('e2', tick)
  test('e3', tick)
})

test('r05', tick)
test('r06', tick)
