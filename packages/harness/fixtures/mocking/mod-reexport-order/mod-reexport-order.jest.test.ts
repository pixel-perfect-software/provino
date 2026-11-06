// Re-exports around an import, with a mock of the first re-exported module.
export * from './a.ts'

import { fooValue } from './foo.ts'

export * from './b.ts'
export { namedValue } from './named.ts'

jest.mock('./a.ts', () => ({ aValue: 'mock-a' }))

const g = globalThis as { loads?: string[] }
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('modules load in this order around a hoisted mock', () => ({ loads: g.loads, fooValue }))

c('a later load of the mocked re-export sees the mock', () => {
  const later = require('./a.ts') as { aValue: string }
  return { aValue: later.aValue, realLoaded: g.loads?.includes('a') }
})
