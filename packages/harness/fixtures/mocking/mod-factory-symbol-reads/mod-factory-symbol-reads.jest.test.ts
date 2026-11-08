jest.mock('./target.ts', () => ({ present: 'mock' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const load = () => require('./target.ts') as Record<string | symbol, unknown>

c('well-known symbols read undefined', () => {
  const target = load()
  return {
    toStringTag: target[Symbol.toStringTag],
    iterator: typeof target[Symbol.iterator],
    toPrimitive: typeof target[Symbol.toPrimitive],
    asyncIterator: typeof target[Symbol.asyncIterator],
  }
})

c('the module-protocol keys', () => {
  const target = load()
  return { thenType: typeof target.then, esModule: target.__esModule }
})

c('an absent string key', () => ({ absent: load().absent }))

c('the object prototype string and JSON', () => {
  const target = load()
  return { tag: Object.prototype.toString.call(target), json: JSON.stringify(target) }
})
