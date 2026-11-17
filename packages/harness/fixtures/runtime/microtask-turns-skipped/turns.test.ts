// How many microtask turns a promise chain a function leaves running gets before the next function
// starts: `mark` starts a chain of promise hops as a function ends, and `seen`, as the next one
// starts, traces how many hops it made. A stale chain stops at its next hop, and a line is
// `<function that ended> -> <function that started>: <turns>`.
let generation = 0
let hops = 0
let from: string | undefined

function mark(label: string): void {
  generation += 1
  const mine = generation
  from = label
  hops = 0
  const hop = (): void => {
    if (generation !== mine) return
    hops += 1
    // A boundary that waited for a timer would never end a chain that queues itself again.
    if (hops < 1000) Promise.resolve().then(hop)
  }
  Promise.resolve().then(hop)
}

function seen(label: string): void {
  if (from !== undefined) trace(`${from} -> ${label}: ${hops >= 1000 ? 'many' : hops}`)
  generation += 1
  from = undefined
}

// A skipped test, a todo and a skipped describe block between tests that run: circus dispatches no
// test_start for them, but it does dispatch `test_skip`, `test_todo` and the block's own events.
test('k a', () => {
  seen('k a')
  mark('k a')
})
it.skip('k skipped', () => {
  seen('k skipped')
})
test('k b', () => {
  seen('k b')
  mark('k b')
})
it.todo('k todo')
test('k c', () => {
  seen('k c')
  mark('k c')
})
describe.skip('k skipped block', () => {
  test('k inside', () => {
    seen('k inside')
  })
})
test('k d', () => {
  seen('k d')
  mark('k d')
})
it.skip('k skipped 1', () => {
  seen('k skipped 1')
})
it.todo('k todo 1')
it.skip('k skipped 2', () => {
  seen('k skipped 2')
})
test('k e', () => {
  seen('k e')
  mark('k e')
})

describe('k with hooks', () => {
  let ran = 0
  beforeEach(() => {
    seen('k beforeEach')
    mark('k beforeEach')
  })
  afterEach(() => {
    seen('k afterEach')
    ran += 1
    if (ran < 2) mark('k afterEach')
  })
  test('k t1', () => {
    seen('k t1')
    mark('k t1')
  })
  it.skip('k skipped in block', () => {
    seen('k skipped in block')
  })
  it.todo('k todo in block')
  test('k t2', () => {
    seen('k t2')
  })
})
