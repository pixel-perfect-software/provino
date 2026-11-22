import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { outputFilesOf } from './native-watch.ts'

describe('the files a run writes itself', () => {
  it('an outputFile is against the working directory, and the html page defaults to each root', () => {
    const files = outputFilesOf(
      ['default', ['json', { outputFile: 'results.json' }], 'html', ['junit', {}], 'json'],
      '/work',
      ['/work/pkg', undefined, '/work'],
    )
    assert.deepEqual(
      [...files].sort(),
      ['/work/pkg/provino-report.html', '/work/provino-report.html', '/work/results.json'].sort(),
    )
  })

  it('names no file for a reporter that writes to stdout or a reporter object', () => {
    assert.equal(outputFilesOf(['json', 'default', { name: 'mine' }], '/work', ['/work']).size, 0)
    assert.equal(outputFilesOf(undefined, '/work', ['/work']).size, 0)
  })
})
