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
