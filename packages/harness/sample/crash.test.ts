// The import fails, so the file crashes before any test is collected, under both runners.
import { missing } from './does-not-exist.ts'

it('is never collected', () => {
  expect(missing).toBeDefined()
})
