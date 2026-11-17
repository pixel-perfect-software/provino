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

// `jest.retryTimes(2)` on a test that fails twice and then passes, with a sibling after it:
// circus defers the retries until the block's other tests have run.
jest.retryTimes(2)
let attempts = 0
test('n flaky', () => {
  attempts += 1
  seen(`n flaky attempt ${attempts}`)
  mark(`n flaky attempt ${attempts}`)
  if (attempts < 3) throw new Error('expected')
})
test('n sibling', () => {
  seen('n sibling')
  mark('n sibling')
})

// With no sibling, the first retry follows the failed attempt's own end.
describe('n alone', () => {
  let aloneAttempts = 0
  test('n alone flaky', () => {
    aloneAttempts += 1
    seen(`n alone attempt ${aloneAttempts}`)
    mark(`n alone attempt ${aloneAttempts}`)
    if (aloneAttempts < 3) throw new Error('expected')
  })
})
