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

// `done` in beforeEach, afterEach and a test, called synchronously and from a timer.
describe('y sync done', () => {
  let ran = 0
  beforeEach((done) => {
    seen('y sync beforeEach')
    mark('y sync beforeEach')
    done()
  })
  afterEach((done) => {
    seen('y sync afterEach')
    ran += 1
    if (ran < 2) mark('y sync afterEach')
    done()
  })
  test('y sync test 1', (done) => {
    seen('y sync test 1')
    mark('y sync test 1')
    done()
  })
  test('y sync test 2', (done) => {
    seen('y sync test 2')
    mark('y sync test 2')
    done()
  })
})

describe('y timer done', () => {
  let ran = 0
  beforeEach((done) => {
    seen('y timer beforeEach')
    setTimeout(() => {
      mark('y timer beforeEach')
      done()
    }, 20)
  })
  afterEach((done) => {
    seen('y timer afterEach')
    setTimeout(() => {
      ran += 1
      if (ran < 2) mark('y timer afterEach')
      done()
    }, 20)
  })
  test('y timer test 1', (done) => {
    seen('y timer test 1')
    setTimeout(() => {
      mark('y timer test 1')
      done()
    }, 20)
  })
  test('y timer test 2', (done) => {
    seen('y timer test 2')
    setTimeout(() => {
      mark('y timer test 2')
      done()
    }, 20)
  })
})
