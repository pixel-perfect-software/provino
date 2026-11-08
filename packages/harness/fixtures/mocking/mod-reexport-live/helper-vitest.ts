import { count as importedCount } from './source.ts'

export { count, inc } from './source.ts'
export { importedCount }

// A mock call makes this file hoist, which rewrites its imports and re-exports.
vi.mock('./unused.ts', () => ({ unused: 'mock' }))
