// File filters over discovered files (U2/T11.13): Jest's TestPathPatterns (jest-pattern 30.5.2).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FileFilter } from '@provino/types'
import type { DiscoveredFile } from './discover.ts'
import { selectFiles } from './select.ts'

const rootDir = '/project'
const file = (relativePath: string): DiscoveredFile => ({
  path: `${rootDir}/${relativePath}`,
  relativePath,
  sizeBytes: 1,
})
const files = [file('src/Alpha.test.ts'), file('src/beta.test.ts'), file('lib/gamma.test.ts')]
const regex = (value: string): FileFilter => ({ kind: 'regex', value })
const keep = (filters: FileFilter[], cwd = rootDir): string[] =>
  selectFiles(files, filters, { rootDir, cwd }).map((entry) => entry.relativePath)

describe('selectFiles', () => {
  it('keeps every file when there is no filter', () => {
    assert.deepEqual(
      keep([]),
      files.map((entry) => entry.relativePath),
    )
  })

  it('keeps the files any regular expression matches, without regard to case', () => {
    assert.deepEqual(keep([regex('alpha')]), ['src/Alpha.test.ts'])
    assert.deepEqual(keep([regex('beta'), regex('^lib/')]), [
      'src/beta.test.ts',
      'lib/gamma.test.ts',
    ])
    assert.deepEqual(keep([regex('nothing')]), [])
  })

  it('tests a pattern on the absolute path too, and anchors "./" to the root', () => {
    assert.deepEqual(keep([regex('/project/src/')]), ['src/Alpha.test.ts', 'src/beta.test.ts'])
    assert.deepEqual(keep([regex('./src/beta')]), ['src/beta.test.ts'])
    assert.deepEqual(keep([regex('./beta')]), [])
  })

  it('keeps the file at each exact path, resolved against cwd, and then ignores the patterns', () => {
    const exact: FileFilter = { kind: 'path', value: 'src/beta.test.ts' }
    assert.deepEqual(keep([exact, regex('gamma')]), ['src/beta.test.ts'])
    assert.deepEqual(keep([{ kind: 'path', value: 'beta.test.ts' }], '/project/src'), [
      'src/beta.test.ts',
    ])
    assert.deepEqual(keep([{ kind: 'path', value: '/project/lib/gamma.test.ts' }]), [
      'lib/gamma.test.ts',
    ])
  })

  it('rejects a pattern that is not a regular expression, and a filter kind not built yet', () => {
    assert.throws(() => keep([regex('(')]), { code: 'ORCH_BAD_PATTERN' })
    assert.throws(() => keep([{ kind: 'substring', value: 'a' }]), { code: 'ORCH_NOT_IMPLEMENTED' })
    assert.throws(() => keep([{ kind: 'pathLine', value: 'a.ts', line: 3 }]), {
      code: 'ORCH_NOT_IMPLEMENTED',
    })
  })
})
