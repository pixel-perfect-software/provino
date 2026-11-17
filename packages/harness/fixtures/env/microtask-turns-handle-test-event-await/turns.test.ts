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

// A chain started at module scope, counted to the first function circus runs: the first beforeAll.
mark('r module scope')
beforeAll(() => {
  seen('r first beforeAll')
})
test('r test', () => {
  seen('r test')
})

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

// Into and out of describe blocks: with and without beforeAll/afterAll, nested, and a block whose
// only test is skipped.
test('d before', () => {
  seen('d before')
  mark('d before')
})

describe('d outer', () => {
  beforeAll(() => {
    seen('d outer beforeAll')
    mark('d outer beforeAll')
  })
  afterAll(() => {
    seen('d outer afterAll')
    mark('d outer afterAll')
  })

  describe('d inner with hooks', () => {
    beforeAll(() => {
      seen('d inner beforeAll')
      mark('d inner beforeAll')
    })
    afterAll(() => {
      seen('d inner afterAll')
      mark('d inner afterAll')
    })
    test('d inner test', () => {
      seen('d inner test')
      mark('d inner test')
    })
  })

  describe('d inner without hooks', () => {
    test('d bare test', () => {
      seen('d bare test')
      mark('d bare test')
    })
  })

  describe('d only skipped', () => {
    it.skip('d skipped', () => {
      seen('d skipped')
    })
  })

  test('d outer test', () => {
    seen('d outer test')
    mark('d outer test')
  })
})

test('d after', () => {
  seen('d after')
  mark('d after')
})

describe('d plain parent', () => {
  describe('d plain child', () => {
    test('d plain test', () => {
      seen('d plain test')
      mark('d plain test')
    })
  })
  test('d parent test', () => {
    seen('d parent test')
    mark('d parent test')
  })
})

describe('d last', () => {
  test('d last test', () => {
    seen('d last test')
  })
})

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
