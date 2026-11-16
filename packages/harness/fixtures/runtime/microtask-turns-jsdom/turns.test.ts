// How many microtask turns a promise chain a function leaves running gets before the next function
// starts: `mark` starts a chain of promise hops as a function ends, and `seen`, as the next one
// starts, traces how many hops it made. jest-circus awaits its event handlers between every test
// and hook, so a chain started in a test gets about 20 turns before `afterEach`. A stale chain
// stops at its next hop. `ran` keeps a describe block's last `afterEach` from marking, so no line
// crosses into the next block.
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

describe('sync hooks', () => {
  let ran = 0
  beforeEach(() => {
    seen('sync beforeEach 1')
    mark('sync beforeEach 1')
  })
  beforeEach(() => {
    seen('sync beforeEach 2')
    mark('sync beforeEach 2')
  })
  afterEach(() => {
    seen('sync afterEach 1')
    mark('sync afterEach 1')
  })
  afterEach(() => {
    seen('sync afterEach 2')
    ran += 1
    if (ran < 4) mark('sync afterEach 2')
  })

  test('sync test', () => {
    seen('sync test')
    mark('sync test')
  })
  test('async test', async () => {
    seen('async test')
    await null
    mark('async test')
  })
  test('failing test', () => {
    seen('failing test')
    mark('failing test')
    throw new Error('expected')
  })
  test('failing async test', async () => {
    seen('failing async test')
    await null
    mark('failing async test')
    throw new Error('expected')
  })
})

describe('async hooks', () => {
  let ran = 0
  beforeEach(async () => {
    seen('async beforeEach 1')
    await null
    mark('async beforeEach 1')
  })
  beforeEach(async () => {
    seen('async beforeEach 2')
    await null
    mark('async beforeEach 2')
  })
  afterEach(async () => {
    seen('async afterEach 1')
    await null
    mark('async afterEach 1')
  })
  afterEach(async () => {
    seen('async afterEach 2')
    await null
    ran += 1
    if (ran < 2) mark('async afterEach 2')
  })

  test('sync test', () => {
    seen('sync test')
    mark('sync test')
  })
  test('async test', async () => {
    seen('async test')
    await null
    mark('async test')
  })
})

describe('no hooks', () => {
  test('sync test 1', () => {
    seen('sync test 1')
    mark('sync test 1')
  })
  test('async test', async () => {
    seen('async test')
    await null
    mark('async test')
  })
  test('failing test', () => {
    seen('failing test')
    mark('failing test')
    throw new Error('expected')
  })
  test.each([1, 2])('row %i', (row) => {
    seen(`row ${row}`)
    mark(`row ${row}`)
  })
  test('sync test 2', () => {
    seen('sync test 2')
  })
})
