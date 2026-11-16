import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The first run (`before`) stores the first values; the captured run, which finds the .snap,
// sends the second ones.
const stored = existsSync(
  join(dirname(expect.getState().testPath ?? ''), '__snapshots__', 'shapes.test.ts.snap'),
)

test('an object with quotes', () => {
  expect({
    quote: stored ? 'say "bye"' : 'say "hi"',
    nested: { list: ['a "b"', 'c'], map: new Map([['k', 'v']]) },
  }).toMatchShapeSnapshot()
})

test('a long list', () => {
  const items = Array.from({ length: 20 }, (_, i) => `item ${i}`)
  if (stored) items[10] = 'item "ten"'
  expect(items).toMatchShapeSnapshot()
})
