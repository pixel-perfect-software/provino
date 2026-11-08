import * as outer from './outer.ts'

vi.mock('./outer.ts', { spy: true })

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a top-level function keeps its behaviour and is spied', () => ({
  result: outer.top(),
  isMock: vi.isMockFunction(outer.top),
  calls: (outer.top as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
}))

c('a re-exported namespace keeps its behaviour and its tag', () => ({
  tag: Object.prototype.toString.call(outer.inner),
  result: outer.inner.innerFn(),
  isMock: vi.isMockFunction(outer.inner.innerFn),
}))

c('an array is copied, with its functions spied and its values kept', () => {
  const [fn, object, value] = outer.list as [() => string, { f: () => string }, number]
  return {
    isArray: Array.isArray(outer.list),
    length: outer.list.length,
    fnResult: fn(),
    fnIsMock: vi.isMockFunction(fn),
    objectFResult: object.f(),
    objectFIsMock: vi.isMockFunction(object.f),
    value,
  }
})
