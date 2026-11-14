// The Windows half of a threshold group's path (T8.11 review): run through `path.win32`, which
// resolves and splits as Windows does on any host, so the rules are checked here and not only on a
// Windows runner. The expected values are what jest-reporters 30.5.2's `_checkThreshold` computes:
// `path.resolve(group)` plus a separator when the group ends in one (`/` too on win32), and
// `glob.sync(pattern, { windowsPathsNoEscape: true })`, which turns every `\` into `/` first.
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import { test } from 'node:test'
import { absoluteGroup, globPatternOf } from './threshold-paths.ts'

const WIN_CWD = 'C:\\proj'

test('win32: a trailing `/` or `\\` on a group is kept as a separator', () => {
  assert.equal(absoluteGroup('./src/', WIN_CWD, win32), 'C:\\proj\\src\\')
  assert.equal(absoluteGroup('.\\src\\', WIN_CWD, win32), 'C:\\proj\\src\\')
  assert.equal(absoluteGroup('./src', WIN_CWD, win32), 'C:\\proj\\src')
})

test('win32: a trailing separator is not added to a root that already ends in one', () => {
  assert.equal(absoluteGroup('C:/', WIN_CWD, win32), 'C:\\')
  assert.equal(absoluteGroup('./', WIN_CWD, win32), 'C:\\proj\\')
})

test('win32: a kept trailing separator keeps `src-other` out of a `src/` group', () => {
  const group = absoluteGroup('./src/', WIN_CWD, win32)
  assert.ok('C:\\proj\\src\\a.ts'.startsWith(group))
  assert.ok(!'C:\\proj\\src-other\\a.ts'.startsWith(group))
  // Without the fix the group read `C:\proj\src`, which both files start with.
  assert.ok('C:\\proj\\src-other\\a.ts'.startsWith(win32.resolve(WIN_CWD, './src/')))
})

test('posix: a trailing `/` is kept, and a `\\` is not a separator', () => {
  assert.equal(absoluteGroup('./src/', '/proj', posix), '/proj/src/')
  assert.equal(absoluteGroup('./src', '/proj', posix), '/proj/src')
  assert.equal(absoluteGroup('src\\', '/proj', posix), '/proj/src\\')
})

test('an absolute group stays as it is (win32 and posix)', () => {
  assert.equal(absoluteGroup('D:\\other\\lib\\', WIN_CWD, win32), 'D:\\other\\lib\\')
  assert.equal(absoluteGroup('/abs/lib/', '/proj', posix), '/abs/lib/')
})

test('the glob pattern has every backslash read as a separator, as glob with windowsPathsNoEscape', () => {
  const windows = absoluteGroup('./src/**/*.ts', WIN_CWD, win32)
  assert.equal(windows, 'C:\\proj\\src\\**\\*.ts')
  assert.equal(globPatternOf(windows), 'C:/proj/src/**/*.ts')
  assert.equal(globPatternOf('/proj/src/**/*.ts'), '/proj/src/**/*.ts')
  // On every platform, as glob 13 does it: an escape is a separator.
  assert.equal(globPatternOf('/proj/src/\\*.ts'), '/proj/src//*.ts')
})
