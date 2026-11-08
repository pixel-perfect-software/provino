import * as named from './named.ts'
import withDefault from './withdefault.ts'

vi.mock('./named.ts', () => ({ a: 'mock-a' }))
vi.mock('./withdefault.ts', () => ({ default: () => 'mock-default' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a factory returning { a }: reading a gives the value, reading b is undefined or throws', () => {
  const read = (key: 'a' | 'b') => {
    try {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the access is what the case reads
      return { value: named[key] }
    } catch (error) {
      return { threw: error }
    }
  }
  return { a: read('a'), b: read('b'), keys: Object.keys(named) }
})

c('a factory returning { default: fn } without __esModule: what the default import is', () => ({
  type: typeof withDefault,
  isFunction: typeof withDefault === 'function',
  keys: typeof withDefault === 'object' ? Object.keys(withDefault as object) : [],
}))
