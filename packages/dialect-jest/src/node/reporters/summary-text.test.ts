// The wording of Jest's summary, held to the cases jest-reporters 30.5.2's SummaryReporter.ts
// L125-L170 (the update command) and L217-L257 (the closing line) spell out; the recorded text is
// `cli/report-snapshot-summary` and `cli/report-ran-*`, run through `provino jest` by `provino`'s
// `reporters.test.ts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TextStyle } from '@provino/types'
import {
  jestRunSummaryLine,
  jestSnapshotStatus,
  jestSnapshotSummary,
  jestUpdateCommand,
} from './summary-text.ts'

const plain = (text: string): string => text
const style: TextStyle = {
  bold: plain,
  dim: plain,
  red: plain,
  green: plain,
  yellow: plain,
  magenta: plain,
  badge: plain,
}

const base = {
  findRelatedTests: false,
  nonFlagArgs: [] as string[],
  onlyChanged: false,
  runTestsByPath: false,
  silent: false as boolean | undefined,
  testNamePattern: undefined as string | undefined,
  testPathPatterns: [] as string[],
}

describe('jestUpdateCommand', () => {
  it('is the watch key in watch mode, whatever npm says', () => {
    assert.equal(jestUpdateCommand({ npm_lifecycle_event: 'test' }, true), 'press `u`')
  })

  it('names the script that runs Jest: `npm test -- -u`, `npm run <event> -- -u`, `yarn test -u`', () => {
    const script = { npm_lifecycle_script: 'jest --ci' }
    assert.equal(
      jestUpdateCommand({ ...script, npm_lifecycle_event: 'test' }, false),
      'run `npm test -- -u`',
    )
    assert.equal(
      jestUpdateCommand({ ...script, npm_lifecycle_event: 'unit' }, false),
      'run `npm run unit -- -u`',
    )
    assert.equal(
      jestUpdateCommand(
        { ...script, npm_lifecycle_event: 'test', npm_config_user_agent: 'yarn/1.22' },
        false,
      ),
      'run `yarn test -u`',
    )
  })

  it('says to re-run jest when the script is not Jest or there is none', () => {
    assert.equal(
      jestUpdateCommand({ npm_lifecycle_event: 'test', npm_lifecycle_script: 'vitest' }, false),
      're-run jest with `-u`',
    )
    assert.equal(jestUpdateCommand({}, false), 're-run jest with `-u`')
  })
})

describe('jestRunSummaryLine', () => {
  const run = { interrupted: false, contextCount: 1 }

  it('narrows by what the run was given', () => {
    assert.equal(jestRunSummaryLine(base, run, style), 'Ran all test suites.')
    assert.equal(
      jestRunSummaryLine({ ...base, testPathPatterns: ['a', 'b'] }, run, style),
      'Ran all test suites matching a|b.',
    )
    assert.equal(
      jestRunSummaryLine({ ...base, testPathPatterns: ['a'], findRelatedTests: true }, run, style),
      'Ran all test suites related to files matching a.',
    )
    assert.equal(
      jestRunSummaryLine({ ...base, onlyChanged: true }, run, style),
      'Ran all test suites related to changed files.',
    )
    assert.equal(
      jestRunSummaryLine(
        { ...base, runTestsByPath: true, nonFlagArgs: ['a.ts', 'b.ts'] },
        run,
        style,
      ),
      'Ran all test suites within paths "a.ts", "b.ts".',
    )
    assert.equal(
      jestRunSummaryLine({ ...base, testNamePattern: 'x' }, { ...run, contextCount: 3 }, style),
      'Ran all test suites with tests matching "x" in 3 projects.',
    )
  })

  it('says the run was interrupted, and says nothing under --silent', () => {
    assert.equal(
      jestRunSummaryLine(base, { ...run, interrupted: true }, style),
      'Test run was interrupted.',
    )
    assert.equal(jestRunSummaryLine({ ...base, silent: true }, run, style), undefined)
  })
})

describe('jestSnapshotSummary', () => {
  const totals = {
    added: 0,
    didUpdate: false,
    failure: false,
    filesAdded: 0,
    filesRemoved: 0,
    filesRemovedList: [] as string[],
    filesUnmatched: 0,
    filesUpdated: 0,
    matched: 0,
    total: 0,
    unchecked: 0,
    uncheckedKeysByFile: [] as { filePath: string; keys: string[] }[],
    unmatched: 0,
    updated: 0,
  }
  const command = 're-run jest with `-u`'

  it('prints nothing for a run with nothing to say', () => {
    assert.deepEqual(jestSnapshotSummary(totals, { rootDir: '/p' }, command, style), [])
  })

  it('lists written, failed and obsolete snapshots with each obsolete key', () => {
    const lines = jestSnapshotSummary(
      {
        ...totals,
        added: 2,
        filesAdded: 1,
        unmatched: 1,
        filesUnmatched: 1,
        unchecked: 1,
        uncheckedKeysByFile: [{ filePath: '/p/a.test.ts', keys: ['k 1'] }],
      },
      { rootDir: '/p' },
      command,
      style,
    )
    assert.deepEqual(lines, [
      'Snapshot Summary',
      ' › 2 snapshots written from 1 test suite.',
      ' › 1 snapshot failed from 1 test suite. Inspect your code changes or re-run jest with `-u` to update them.',
      ' › 1 snapshot obsolete from 1 test suite. To remove it, re-run jest with `-u`.',
      '   ↳ ./a.test.ts',
      '       • k 1',
    ])
  })

  it('says removed after -u, and lists the snapshot files that were orphans', () => {
    const lines = jestSnapshotSummary(
      {
        ...totals,
        didUpdate: true,
        filesRemoved: 2,
        filesRemovedList: ['/p/__snapshots__/a.snap', '/p/__snapshots__/b.snap'],
      },
      { rootDir: '/p' },
      command,
      style,
    )
    assert.deepEqual(lines, [
      'Snapshot Summary',
      ' › 2 snapshot files removed from 2 test suites.',
      '   ↳   • __snapshots__/a.snap',
      '       • __snapshots__/b.snap',
    ])
  })
})

describe('jestSnapshotStatus', () => {
  const empty = {
    added: 0,
    fileDeleted: false,
    matched: 0,
    unchecked: 0,
    uncheckedKeys: [] as string[],
    unmatched: 0,
    updated: 0,
  }

  it('has a line for each count, and the obsolete keys under theirs', () => {
    assert.deepEqual(jestSnapshotStatus(empty, false, style), [])
    assert.deepEqual(
      jestSnapshotStatus(
        { ...empty, added: 1, updated: 2, unmatched: 1, unchecked: 1, uncheckedKeys: ['k'] },
        false,
        style,
      ),
      [
        ' › 1 snapshot written.',
        ' › 2 snapshots updated.',
        ' › 1 snapshot failed.',
        ' › 1 snapshot obsolete.',
        '   • k',
      ],
    )
  })

  it('says removed for an obsolete snapshot after an update, and for a deleted file', () => {
    assert.deepEqual(
      jestSnapshotStatus(
        { ...empty, unchecked: 1, uncheckedKeys: ['k'], fileDeleted: true },
        true,
        style,
      ),
      [' › 1 snapshot removed.', '   • k', ' › snapshot file removed.'],
    )
  })
})
