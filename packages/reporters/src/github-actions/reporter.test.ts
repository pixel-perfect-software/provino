import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ReportPolicy } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  collectedEvent,
  consoleEvent,
  error,
  type FileSpec,
  output,
  playRun,
  resultOf,
  type TestSpec,
  testEndEvent,
  unhandledEvent,
} from '../internal/test-support.ts'
import { githubActionsReporter } from './reporter.ts'

const REPORT: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  resultStatusSkipped: 'pending',
}

async function annotations(
  files: readonly FileSpec[],
  options: { readonly workspace?: string; readonly unhandled?: Parameters<typeof playRun>[2] } = {},
): Promise<string[]> {
  const out = output()
  const bus = createReporterBus([
    githubActionsReporter({
      stream: out,
      report: REPORT,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    }),
  ])
  await playRun(bus, files, options.unhandled ?? {})
  assert.deepEqual(bus.failures(), [])
  return out.text().split('\n').filter(Boolean)
}

const fails = (
  path: string,
  errors = [error('boom')],
  extra: Partial<TestSpec> = {},
): FileSpec => ({
  path,
  tests: [{ path: ['group', 'case'], state: 'fail', errors, ...extra }],
})

describe('the github-actions reporter', () => {
  test('is a reporter named github-actions', () => {
    assert.equal(githubActionsReporter({ stream: output(), report: REPORT }).name, 'github-actions')
  })

  test('prints nothing for a passing run', async () => {
    assert.deepEqual(await annotations([{ path: 'a.test.ts', tests: [{ path: ['t'] }] }]), [])
  })

  test('annotates a failed test as an error, titled with its names joined by the dialect’s separator', async () => {
    const [line, ...rest] = await annotations([fails('a.test.ts')])
    assert.deepEqual(rest, [])
    assert.equal(line, '::error file=a.test.ts,title=group › case::boom')
  })

  test('points at the error’s own location first', async () => {
    const [line] = await annotations([
      fails('a.test.ts', [
        error('boom', {
          location: { file: '/project/src/a.test.ts', line: 7, column: 3 },
          stack: 'Error: boom\n    at x (/project/other.ts:1:1)',
        }),
      ]),
    ])
    assert.match(line ?? '', /^::error file=src\/a\.test\.ts,line=7,col=3,title=group › case::boom/)
  })

  test('then the first frame of the stack that is not a library’s', async () => {
    const [line] = await annotations([
      fails('a.test.ts', [
        error('boom', {
          stack: [
            'Error: boom',
            '    at lib (/project/node_modules/lib/index.js:5:5)',
            '    at node:internal/x:1:1',
            '    at Object.<anonymous> (file:///project/src/b.test.ts:12:9)',
          ].join('\n'),
        }),
      ]),
    ])
    assert.match(line ?? '', /^::error file=src\/b\.test\.ts,line=12,col=9,/)
  })

  test('reads a frame with no function name, and one that is relative to the project', async () => {
    const [bare] = await annotations([
      fails('a.test.ts', [
        error('boom', { stack: 'Error: boom\n    at /project/src/c.test.ts:3:4' }),
      ]),
    ])
    assert.match(bare ?? '', /file=src\/c\.test\.ts,line=3,col=4/)
    const [relative] = await annotations([
      fails('a.test.ts', [error('boom', { stack: 'Error: boom\n    at run (src/d.test.ts:8:2)' })]),
    ])
    assert.match(relative ?? '', /file=src\/d\.test\.ts,line=8,col=2/)
  })

  test('falls back to the test’s own line, then to the file alone', async () => {
    const [own] = await annotations([
      fails('a.test.ts', [error('boom')], { location: { line: 4, column: 3 } }),
    ])
    assert.match(own ?? '', /^::error file=a\.test\.ts,line=4,col=3,/)
    const [none] = await annotations([fails('a.test.ts')])
    assert.match(none ?? '', /^::error file=a\.test\.ts,title=/)
  })

  test('makes paths relative to the workspace when given one, with forward slashes', async () => {
    const [line] = await annotations(
      [
        fails('src/a.test.ts', [
          error('boom', { stack: 'Error: boom\n    at x (/repo/packages/app/src/a.test.ts:2:2)' }),
        ]),
      ],
      { workspace: '/' },
    )
    assert.match(line ?? '', /^::error file=repo\/packages\/app\/src\/a\.test\.ts,line=2,col=2,/)
    const [relative] = await annotations([fails('src/a.test.ts')], { workspace: '/' })
    assert.match(relative ?? '', /^::error file=project\/src\/a\.test\.ts,/)
  })

  test('escapes the message as a workflow command does: %, carriage return and line feed', async () => {
    const [line] = await annotations([fails('a.test.ts', [error('100% done\r\nnext line')])])
    assert.ok((line ?? '').endsWith('::100%25 done%0D%0Anext line'))
    assert.equal((line ?? '').split('\n').length, 1)
  })

  test('escapes a property too: colon and comma', async () => {
    const [line] = await annotations([
      {
        path: 'a.test.ts',
        tests: [{ path: ['uses: a, b'], state: 'fail', errors: [error('x')] }],
      },
    ])
    assert.match(line ?? '', /title=uses%3A a%2C b::/)
  })

  test('drops ANSI from the message and the title', async () => {
    const [line] = await annotations([
      {
        path: 'a.test.ts',
        tests: [
          {
            path: ['\u001b[1mbold\u001b[22m'],
            state: 'fail',
            errors: [error('\u001b[31mred\u001b[39m')],
          },
        ],
      },
    ])
    assert.match(line ?? '', /title=bold::red$/)
  })

  test('annotates each failed test of a file, and a file that failed to run', async () => {
    const lines = await annotations([
      {
        path: 'a.test.ts',
        tests: [
          { path: ['one'], state: 'fail', errors: [error('first')] },
          { path: ['two'] },
          { path: ['three'], state: 'fail', errors: [error('third')] },
        ],
      },
      {
        path: 'broken.test.ts',
        state: 'fail',
        errors: [error('cannot load', { name: 'ImportError' })],
      },
    ])
    assert.equal(lines.length, 3)
    assert.match(lines[0] ?? '', /title=one::first/)
    assert.match(lines[1] ?? '', /title=three::third/)
    assert.match(
      lines[2] ?? '',
      /^::error file=broken\.test\.ts,title=broken\.test\.ts::ImportError: cannot load/,
    )
  })

  test('does not annotate a skipped or todo test', async () => {
    assert.deepEqual(
      await annotations([
        {
          path: 'a.test.ts',
          tests: [
            { path: ['s'], state: 'skip' },
            { path: ['t'], state: 'todo' },
          ],
        },
      ]),
      [],
    )
  })

  test('annotates an unhandled error from the run, and an error event, with no file', async () => {
    const out = output()
    const bus = createReporterBus([githubActionsReporter({ stream: out, report: REPORT })])
    await bus.emit(
      'run:start',
      { root: '/project', projects: [''], startTime: 0, watch: false },
      [],
    )
    await bus.emit('error', error('setup broke'), 'globalSetup')
    await bus.emit('run:end', {
      reason: 'failed',
      files: [],
      unhandled: [error('stray rejection', { name: 'RangeError' })],
      durationMs: 1,
    })
    assert.equal(
      out.text(),
      [
        '::error title=Provino%3A globalSetup error::setup broke',
        '::error title=Unhandled error::RangeError: stray rejection',
        '',
      ].join('\n'),
    )
  })

  test('forgets a file once it has printed it, and starts over at each run', async () => {
    const out = output()
    const bus = createReporterBus([githubActionsReporter({ stream: out, report: REPORT })])
    await playRun(bus, [fails('a.test.ts')])
    const first = out.text()
    await playRun(bus, [{ path: 'b.test.ts', tests: [{ path: ['t'] }] }])
    assert.equal(out.text(), first)
  })

  test('annotates an error charged to a file after it ended, on the file, and ignores its late console writes', async () => {
    const out = output()
    const bus = createReporterBus([githubActionsReporter({ stream: out, report: REPORT })])
    const file = buildFile({ path: 'late.test.ts', tests: [{ path: ['t'] }] })
    await bus.emit('run:start', { root: '/project', projects: [''], startTime: 0, watch: false }, [
      file.info,
    ])
    await bus.emit('file:collected', file.info, collectedEvent(file))
    const [owner] = file.tests
    assert.ok(owner !== undefined)
    await bus.emit('task:end', owner.task, testEndEvent(owner.task, resultOf(owner.spec)))
    await bus.emit('file:end', file.result)
    assert.equal(out.text(), '', 'the test passed, so nothing yet')
    await bus.emit('console', file.info, consoleEvent({ text: 'too late\n' }, owner.task.id))
    await bus.emit('unhandled', file.info, unhandledEvent(error('LATE BOOM'), owner.task.id))
    await bus.emit('run:end', {
      reason: 'failed',
      files: [file.result],
      unhandled: [],
      durationMs: 1,
    })
    assert.deepEqual(out.text().split('\n').filter(Boolean), [
      '::error file=late.test.ts,title=late.test.ts::LATE BOOM',
    ])
    assert.deepEqual(bus.failures(), [])
  })
})
