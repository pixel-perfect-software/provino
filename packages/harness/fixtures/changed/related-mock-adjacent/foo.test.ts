// biome-ignore lint/correctness/useImportExtensions: with an extension jest-resolve-dependencies looks for a mock named `foo.ts`
const m = require('./src/foo') as Record<string, unknown>

test('works', () => {
  expect(m).toBeDefined()
})
