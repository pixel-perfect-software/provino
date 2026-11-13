let repeated = 0
let retried = 0
let failing = 0

beforeAll(() => trace('beforeAll'))
beforeEach(() => trace('beforeEach'))
afterEach(() => trace('afterEach'))
afterAll(() => trace('afterAll'))

test('repeats twice', { repeats: 2 }, () => trace(`repeat run ${++repeated}`))

test('each repeat has its retries', { repeats: 1, retry: 1 }, () => {
  trace(`retried run ${++retried}`)
  // The first run of each repeat (runs 1 and 3) fails, its retry passes.
  if (retried % 2 === 1) throw new Error(`retried run ${retried} failed`)
})

test('a failed repeat does not stop the next', { repeats: 2 }, () => {
  trace(`failing run ${++failing}`)
  if (failing === 2) throw new Error('the second run failed')
})
