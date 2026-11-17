import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildFile } from '../../internal/test-support.ts'
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
    assert.deepEqual(fileOutcome(finished('src/a/x.test.ts')), {
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

  test('a file of only todo tests is a todo file', () => {
    const built = buildFile({ path: 'a.test.ts', tests: [{ path: ['t'], state: 'todo' }] })
    const state = createRunState()
    state.start([built.info], 0)
    state.fileStart(built.info, 0, 1)
    state.testEnd(built.info.fileId, 'todo')
    assert.equal(fileOutcome(state.fileEnd(built.result)).kind, 'todo')
  })
})
