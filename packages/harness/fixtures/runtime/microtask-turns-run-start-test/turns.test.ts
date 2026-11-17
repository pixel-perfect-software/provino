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

// A chain started at module scope, counted to the first function circus runs: a test, no hooks.
mark('q module scope')
test('q first test', () => {
  seen('q first test')
})
