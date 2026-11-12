// A child process for `store.test.ts`: writes and reads the same keys as its siblings, against one
// directory, and reports whether any read returned something other than the whole entry. Not part
// of the package's exports.
import { createTransformCache } from './store.ts'
import { entryFor, KEY_COUNT, keyFor } from './test-entries.ts'

const [dir = '', indexText = '0'] = process.argv.slice(2)
const index = Number(indexText)
const cache = createTransformCache(dir)
let torn = 0
let hits = 0

for (let round = 0; round < 3; round++) {
  for (let step = 0; step < KEY_COUNT; step++) {
    // Each process starts at its own place, so they collide on different keys at different times.
    const n = (step + index * 61) % KEY_COUNT
    const key = keyFor(n)
    const before = cache.get(key)
    if (before !== undefined) {
      hits++
      const expected = entryFor(n)
      if (before.code !== expected.code || before.imports.length !== expected.imports.length) torn++
    }
    cache.set(key, { ...entryFor(n), cacheKey: key, fromCache: false })
  }
}
process.stdout.write(JSON.stringify({ torn, hits }))
