// The reporter host and the built-in names (T11.9, B23a): `provino jest` against what Jest 30.5.2
// printed for the same project (`cli/reporters-*`): the hooks a reporter class gets and in which
// order, `reporters: ['summary']` and a `summaryThreshold`, and a reporter module that can't load.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** Our stderr as the recording sees Jest's: the lines it kept, with each timing taken out. */
function kept(stderr: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return stderr.split('\n').filter((line) => keep.test(line))
}

async function provinoOn(
  id: string,
  extra: (root: string) => readonly string[] = () => [],
): Promise<{
  readonly code: number | null
  readonly lines: string[]
  readonly expected: string[]
  readonly expectedCode: number | null | undefined
  readonly stderr: string
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const keepLines = fixture.manifest.run?.keepLines
    assert.ok(keepLines !== undefined, `${id} keeps lines`)
    const ended = await spawnCli(
      [
        'jest',
        `--config=${join(project.root, 'jest.config.json')}`,
        '--ci',
        ...(fixture.manifest.run?.argv?.jest ?? []),
        ...extra(project.root),
      ],
      { cwd: project.root },
    )
    const golden = fixture.golden.observed
    return {
      code: ended.code,
      lines: kept(ended.stderr, keepLines),
      expected: kept(golden?.stderr ?? '', keepLines),
      expectedCode: golden?.exitCode,
      stderr: ended.stderr,
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest hosts Jest reporter classes as Jest does (cli/reporters-hook-order)', () => {
  it('calls every hook in Jest’s order with Jest’s arguments, and getLastError fails the run', async () => {
    const run = await provinoOn('cli/reporters-hook-order')
    assert.ok(run.expected.length >= 15, 'the recording kept the hooks')
    assert.deepEqual(run.lines, run.expected, run.stderr)
    assert.equal(run.code, run.expectedCode, run.stderr)
    assert.equal(run.expectedCode, 1)
  })

  it('takes the reporter from --reporters on the command line as well', async () => {
    const run = await provinoOn('cli/reporters-hook-order', (root) => [
      `--reporters=${join(root, 'hook-reporter.cjs')}`,
    ])
    assert.deepEqual(run.lines, run.expected, run.stderr)
    assert.equal(run.code, run.expectedCode, run.stderr)
  })

  it('ends the run before any file with Jest’s message when a reporter module is missing', async () => {
    const fixture = await loadFixture('cli/reporters-hook-order')
    const project = await materialize(fixture)
    try {
      await writeFile(join(project.root, 'throws.cjs'), "throw new Error('cannot load')\n")
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          `--reporters=${join(project.root, 'throws.cjs')}`,
        ],
        { cwd: project.root },
      )
      assert.equal(ended.code, 1, ended.stderr)
      assert.match(
        ended.stderr,
        /An error occurred while adding the reporter at path ".*throws\.cjs"\./,
      )
      assert.match(ended.stderr, /cannot load/)
      assert.doesNotMatch(ended.stderr, /HOOK /)
    } finally {
      await project.dispose()
    }
  })
})

describe('provino jest names the built-in reporters as Jest does', () => {
  for (const [id, what] of [
    ['cli/reporters-summary-only', "reporters: ['summary'] prints the totals and no file"],
    [
      'cli/reporters-summary-threshold',
      "summaryThreshold: 1 prints the failures again under 'Summary of all failing tests'",
    ],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const run = await provinoOn(id)
      assert.ok(run.expected.length >= 3, 'the recording kept lines')
      assert.deepEqual(run.lines, run.expected, run.stderr)
      assert.equal(run.code, run.expectedCode, run.stderr)
    })
  }
})

/** A materialized fixture whose config is replaced by `overrides`, run with the bin. */
async function runWithConfig(
  id: string,
  overrides: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const path = join(project.root, 'jest.config.json')
    const base = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...base, ...overrides }))
    for (const [name, text] of Object.entries(files)) await writeFile(join(project.root, name), text)
    const ended = await spawnCli(['jest', `--config=${path}`, '--ci'], { cwd: project.root })
    return { code: ended.code, stderr: ended.stderr, stdout: ended.stdout }
  } finally {
    await project.dispose()
  }
}

describe('summaryThreshold is checked as Jest checks it (SummaryReporter._validateOptions)', () => {
  for (const value of [null, false, '', 0]) {
    it(`accepts ${JSON.stringify(value)} and uses the default`, async () => {
      const run = await runWithConfig('cli/reporters-summary-only', {
        reporters: [['summary', { summaryThreshold: value }]],
      })
      assert.doesNotMatch(run.stderr, /summaryThreshold should be a number/)
      assert.match(run.stderr, /^Tests:/m)
    })
  }

  it('refuses a non-empty value that is not a number', async () => {
    const run = await runWithConfig('cli/reporters-summary-only', {
      reporters: [['summary', { summaryThreshold: '5' }]],
    })
    assert.match(run.stderr, /The option summaryThreshold should be a number/)
    assert.equal(run.code, 1)
  })
})

describe('an error a reporter throws is printed when no text reporter is there to show it', () => {
  const FIXTURE = 'cli/reporters-summary-only'
  const HOOK = "module.exports = class { onRunComplete() { throw new Error('hook nope') } }\n"

  it('prints a constructor error with Jest’s wrapped message and fails the run', async () => {
    const run = await runWithConfig(
      FIXTURE,
      { reporters: ['<rootDir>/throws.cjs'] },
      {
        'throws.cjs': "module.exports = class { constructor() { throw new Error('ctor nope') } }\n",
      },
    )
    assert.equal(run.code, 1, run.stderr)
    assert.match(
      run.stderr,
      /An error occurred while adding the reporter at path ".*throws\.cjs"\./,
    )
    assert.match(run.stderr, /ctor nope/)
  })

  it('prints what a hook throws', async () => {
    const run = await runWithConfig(
      FIXTURE,
      { reporters: ['<rootDir>/hook.cjs'] },
      { 'hook.cjs': HOOK },
    )
    assert.equal(run.code, 1, run.stderr)
    assert.match(run.stderr, /hook nope/)
  })

  it('leaves it to the default reporter when that is there (no second copy)', async () => {
    const run = await runWithConfig(
      FIXTURE,
      { reporters: ['default', '<rootDir>/hook.cjs'] },
      { 'hook.cjs': HOOK },
    )
    assert.equal(run.code, 1, run.stderr)
    assert.equal(run.stderr.split('hook nope').length - 1, 1, run.stderr)
  })
})
