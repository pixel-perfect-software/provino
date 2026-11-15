import { BLUE, png, RED } from './png.ts'

// Both versions are one stored image: v2 differs from v1 in one pixel of sixteen.
const customSnapshotIdentifier = 'shared-image'

test('v1', () => {
  expect(png(4, 4, () => RED)).toMatchImageSnapshot({ customSnapshotIdentifier })
})

test('v2', () => {
  expect(png(4, 4, (x, y) => (x === 1 && y === 2 ? BLUE : RED))).toMatchImageSnapshot({
    customSnapshotIdentifier,
  })
})
