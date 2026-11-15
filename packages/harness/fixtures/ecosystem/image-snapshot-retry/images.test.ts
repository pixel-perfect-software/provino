import { BLUE, GREEN, png, RED } from './png.ts'

// Each test's first attempt takes its snapshots and then fails; the retry takes them again and
// passes. jest-image-snapshot reads the file's retry count (`Symbol.for('RETRY_TIMES')`) and then
// wants a `customSnapshotIdentifier`. What a retry takes back is jest-snapshot's own accounting
// (`clear(test)`): the image matcher's writes to `_counters` and the four counts are not in it,
// except where `toMatchSnapshot` put the test's counter in the attempt's record first.
jest.retryTimes(1)

const attempts: Record<string, number> = {}
function failFirst(name: string): void {
  attempts[name] = (attempts[name] ?? 0) + 1
  if (attempts[name] === 1) throw new Error(`${name}: first attempt`)
}

test('no identifier', () => {
  expect(png(2, 2, () => RED)).toMatchImageSnapshot()
})

test('image', () => {
  expect(png(2, 2, () => RED)).toMatchImageSnapshot({ customSnapshotIdentifier: 'retry-image' })
  failFirst('image')
})

test('image then snapshot', () => {
  expect(png(2, 2, () => GREEN)).toMatchImageSnapshot({ customSnapshotIdentifier: 'retry-mixed' })
  expect('after').toMatchSnapshot()
  failFirst('image then snapshot')
})

test('snapshot then image', () => {
  expect('before').toMatchSnapshot()
  expect(png(2, 2, () => BLUE)).toMatchImageSnapshot({ customSnapshotIdentifier: 'retry-after' })
  expect('after').toMatchSnapshot()
  failFirst('snapshot then image')
})
