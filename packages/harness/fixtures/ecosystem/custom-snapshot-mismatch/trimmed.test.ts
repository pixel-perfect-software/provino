import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The first run (`before`) stores the first values; the captured run, which finds the .snap,
// sends the second ones.
const stored = existsSync(
  join(dirname(expect.getState().testPath ?? ''), '__snapshots__', 'trimmed.test.ts.snap'),
)

test('trimmed', () => {
  expect(
    stored ? 'EXTRA long string oh my gerd' : 'extra long string oh my gerd',
  ).toMatchTrimmedSnapshot(10)
})

test('beside toMatchSnapshot', () => {
  expect('first').toMatchSnapshot()
  expect('second, trimmed').toMatchTrimmedSnapshot(6)
  expect('third').toMatchSnapshot()
})

test('with properties', () => {
  expect(stored ? { id: 'seven', name: 'seven' } : { id: 7, name: 'seven' }).toMatchIdSnapshot()
})
