import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { posixRelative, toPosix } from '../../internal/posix-relative.ts'
import { buildFile } from '../../internal/test-support.ts'
import { groupByFolder } from '../../internal/views/folders.ts'
import { fileOutcome } from './file-outcome.ts'
import { createRunState, type FinishedFile } from './state.ts'

/** A finished file at `path`, as the state hands it over. */
function finished(path: string, runPath?: string): FinishedFile {
  const built = buildFile({ path, tests: [{ path: ['t'] }, { path: ['todo'], state: 'todo' }] })
  const info = runPath === undefined ? built.info : { ...built.info, runPath }
  const state = createRunState()
  state.start([info], 0)
  state.fileStart(info, 0, 1)
  state.testEnd(info.fileId, 'pass')
  state.testEnd(info.fileId, 'todo')
  return state.fileEnd({ ...built.result, file: info })
}

describe('a finished file as the views need it', () => {
  test('its run path, project, kind and counts', () => {
    const row = fileOutcome(finished('src/a/x.test.ts'))
    assert.deepEqual(row, {
      path: 'src/a/x.test.ts',
      project: '',
      kind: 'pass',
      tests: 2,
      failed: 0,
      skipped: 1,
      durationMs: 5,
    })
  })

  test('the run path is the one grouped by, when there is one', () => {
    assert.equal(fileOutcome(finished('x.test.ts', 'pkg/x.test.ts')).path, 'pkg/x.test.ts')
  })

  test('a native Windows path becomes a POSIX one, so its folder is not `.`', () => {
    const row = fileOutcome(finished('src\\a\\x.test.ts'), '\\')
    assert.equal(row.path, 'src/a/x.test.ts')
    assert.equal(groupByFolder([row])[0]?.dir, 'src/a')
    // The run path too, not only the fallback.
    assert.equal(fileOutcome(finished('x', 'pkg\\y.test.ts'), '\\').path, 'pkg/y.test.ts')
  })

  test('on a POSIX host a backslash is part of a name and stays', () => {
    assert.equal(fileOutcome(finished('src/odd\\name.test.ts'), '/').path, 'src/odd\\name.test.ts')
  })
})

describe('toPosix', () => {
  test('swaps the platform’s separator for `/`, and leaves a POSIX path alone', () => {
    assert.equal(toPosix('a\\b\\c', '\\'), 'a/b/c')
    assert.equal(toPosix('a/b/c', '\\'), 'a/b/c')
    assert.equal(toPosix('a\\b', '/'), 'a\\b')
    assert.equal(toPosix('a/b'), 'a/b')
  })

  test('posixRelative still gives `/` between the parts', () => {
    assert.equal(posixRelative('/root', '/root/a/b.ts'), 'a/b.ts')
  })
})
