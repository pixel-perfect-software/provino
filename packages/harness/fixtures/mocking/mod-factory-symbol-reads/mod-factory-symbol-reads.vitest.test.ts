vi.mock('./target.ts', () => ({ present: 'mock' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const load = async () =>
  (await import('./target.ts')) as unknown as Record<string | symbol, unknown>

c('well-known symbols read undefined', async () => {
  const target = await load()
  return {
    toStringTag: target[Symbol.toStringTag],
    iterator: typeof target[Symbol.iterator],
    toPrimitive: typeof target[Symbol.toPrimitive],
    asyncIterator: typeof target[Symbol.asyncIterator],
  }
})

c('the module-protocol keys', async () => {
  const target = await load()
  return { thenType: typeof target.then, esModule: target.__esModule }
})

c('an absent string key', async () => ({ absent: (await load()).absent }))

c('the object prototype string and JSON', async () => {
  const target = await load()
  return { tag: Object.prototype.toString.call(target), json: JSON.stringify(target) }
})
