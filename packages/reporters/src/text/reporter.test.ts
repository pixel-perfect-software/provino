import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Reporter, ReportPolicy } from '@provino/types'
import { agentReporter } from '../agent/reporter.ts'
import { createReporterBus } from '../bus.ts'
import { defaultReporter } from '../default/reporter.ts'
import { dotReporter } from '../dot/reporter.ts'
import {
  buildFile,
  collectedEvent,
  error,
  type FileSpec,
  JEST_REPORT,
  NEUTRAL_REPORT,
  output,
  playRun,
  resultOf,
  testEndEvent,
} from '../internal/test-support.ts'
import { verboseReporter } from '../verbose/reporter.ts'
import type { TextReporterOptions } from './reporter.ts'

/** Jest's wording, without its one-file listing, which `listTestsForSingleFile` tests apart. */
const REPORT: ReportPolicy = { ...JEST_REPORT, listTestsForSingleFile: false }

const ESC = String.fromCharCode(27)

/** Runs `files` through the reporter `make` builds, and returns what it wrote. */
async function written(
  make: (options: TextReporterOptions) => Reporter,
  files: readonly FileSpec[],
  options: Partial<TextReporterOptions> = {},
): Promise<string> {
  const out = output()
  const bus = createReporterBus([make({ stream: out, report: REPORT, ...options })])
  await playRun(bus, files)
  assert.deepEqual(bus.failures(), [])
  return out.text()
}

const CONSOLE_FILE: FileSpec = {
  path: 'console.test.ts',
  tests: [
    {
      path: ['logs'],
      console: [
        { text: 'one\n' },
        { level: 'warn', stream: 'stderr', text: 'two\nsecond line\n' },
        { level: 'error', stream: 'stderr', text: 'three\n' },
        { level: null, text: 'raw\n' },
      ],
    },
  ],
}

describe('the default reporter: console output', () => {
  test('prints a file’s console calls under its header, as Jest’s Console block (cli/report-default)', async () => {
    const text = await written(defaultReporter, [CONSOLE_FILE])
    assert.equal(
      text,
      [
        'PASS ./console.test.ts',
        '  ● Console',
        '',
        '    console.log',
        '      one',
        '',
        '    console.warn',
        '      two',
        '      second line',
        '',
        '    console.error',
        '      three',
        '',
        '    process.stdout',
        '      raw',
        '',
        'Test Suites: 1 passed, 1 total',
        'Tests:       1 passed, 1 total',
        'Time:        1.234 s',
        '',
      ].join('\n'),
    )
  })

  test('prints no block for a file that wrote nothing', async () => {
    const text = await written(defaultReporter, [{ path: 'a.test.ts', tests: [{ path: ['t'] }] }])
    assert.doesNotMatch(text, /Console/)
  })

  test('prints none of it under silent (Jest’s --silent, cli/report-silent)', async () => {
    const text = await written(defaultReporter, [CONSOLE_FILE], { silent: true })
    assert.doesNotMatch(text, /● Console|console\.(log|warn|error)|process\.stdout/)
    assert.match(text, /^PASS \.\/console\.test\.ts\n/)
  })

  test('puts the console block before the failed test’s message, as Jest does', async () => {
    const text = await written(defaultReporter, [
      {
        path: 'both.test.ts',
        console: [{ text: 'before\n' }],
        tests: [{ path: ['t'], state: 'fail', errors: [error('boom')] }],
      },
    ])
    assert.ok(text.indexOf('Console') < text.indexOf('● t'), text)
  })

  test('a file’s console output does not leak into the next file', async () => {
    const text = await written(defaultReporter, [
      CONSOLE_FILE,
      { path: 'quiet.test.ts', tests: [{ path: ['t'] }] },
    ])
    assert.equal(text.split('Console').length, 2)
  })

  test('colours warn yellow and error red, and the other titles dim', async () => {
    const text = await written(defaultReporter, [CONSOLE_FILE], { colour: true })
    assert.match(text, new RegExp(`${ESC}\\[33mconsole\\.warn${ESC}\\[39m`))
    assert.match(text, new RegExp(`${ESC}\\[31mconsole\\.error${ESC}\\[39m`))
    assert.match(text, new RegExp(`${ESC}\\[2mconsole\\.log${ESC}\\[22m`))
  })

  test('prints the origin’s top frame under an entry when the worker gave one; none of a warn’s under noStackTrace', async () => {
    const withOrigin: FileSpec = {
      path: 'origin.test.ts',
      tests: [
        {
          path: ['t'],
          console: [
            {
              text: 'hi\n',
              origin: 'Error\n    at Object.log (origin.test.ts:2:11)\n    at x (y.ts:1:1)',
            },
            {
              level: 'warn',
              stream: 'stderr',
              text: 'careful\n',
              origin: 'Error\n    at Object.warn (origin.test.ts:3:11)',
            },
          ],
        },
      ],
    }
    const text = await written(defaultReporter, [withOrigin])
    assert.match(text, / {4}console\.log\n {6}hi\n\n {6}at Object\.log \(origin\.test\.ts:2:11\)\n/)
    assert.doesNotMatch(text, /y\.ts/)
    const quiet = await written(defaultReporter, [withOrigin], { noStackTrace: true })
    assert.match(quiet, /at Object\.log/)
    assert.doesNotMatch(quiet, /at Object\.warn/)
  })
})

// The orchestrator decides a file's state once (`orchestrator.todoOnlyFile`, DV50): the reporter
// prints what `FileResult.state` says.
describe('the default reporter: a skipped or todo-only file (DV50)', () => {
  test('prints PASS for a file whose tests are only todo and that the orchestrator passed', async () => {
    const text = await written(defaultReporter, [
      { path: 'todo.test.ts', state: 'pass', tests: [{ path: ['later'], state: 'todo' }] },
    ])
    assert.match(text, /^PASS \.\/todo\.test\.ts\n/)
    assert.match(text, /Test Suites: 1 passed, 1 total/)
    assert.match(text, /Tests: {7}1 todo, 1 total/)
  })

  test('prints PASS for a file with a skipped and a todo test that the orchestrator passed', async () => {
    const text = await written(defaultReporter, [
      {
        path: 'mixed.test.ts',
        state: 'pass',
        tests: [
          { path: ['a'], state: 'skip' },
          { path: ['b'], state: 'todo' },
        ],
      },
    ])
    assert.match(text, /^PASS \.\/mixed\.test\.ts\n/)
    assert.match(text, /Test Suites: 1 passed, 1 total/)
  })

  test('prints nothing for a todo-only file the orchestrator called skipped (the neutral rule)', async () => {
    const text = await written(defaultReporter, [
      { path: 'todo.test.ts', state: 'skip', tests: [{ path: ['later'], state: 'todo' }] },
    ])
    assert.doesNotMatch(text, /todo\.test\.ts/)
    assert.match(text, /Test Suites: 1 skipped, 0 of 1 total/)
  })

  test('prints nothing for a file whose every test is skipped, and counts it skipped', async () => {
    const text = await written(defaultReporter, [
      { path: 'skip.test.ts', state: 'skip', tests: [{ path: ['a'], state: 'skip' }] },
      { path: 'ran.test.ts', tests: [{ path: ['b'] }] },
    ])
    assert.doesNotMatch(text, /skip\.test\.ts/)
    assert.match(text, /Test Suites: 1 skipped, 1 passed, 1 of 2 total/)
  })
})

describe('a slow file', () => {
  test('says how long it took after 5 s, in seconds, and not before', async () => {
    const text = await written(defaultReporter, [
      { path: 'slow.test.ts', durationMs: 7234, tests: [{ path: ['t'] }] },
      { path: 'edge.test.ts', durationMs: 5000, tests: [{ path: ['t'] }] },
      { path: 'quick.test.ts', durationMs: 4999, tests: [{ path: ['t'] }] },
    ])
    assert.match(text, /^PASS \.\/slow\.test\.ts \(7\.234 s\)$/m)
    assert.match(text, /^PASS \.\/edge\.test\.ts$/m)
    assert.match(text, /^PASS \.\/quick\.test\.ts$/m)
  })

  test('reads 5.2 s as Jest’s slow marker does, for a failing file too', async () => {
    const text = await written(defaultReporter, [
      {
        path: 'slow.test.ts',
        durationMs: 5200,
        tests: [{ path: ['t'], state: 'fail', errors: [error('x')] }],
      },
    ])
    assert.match(text, /^FAIL \.\/slow\.test\.ts \(5\.2 s\)$/m)
  })
})

describe('the file label', () => {
  test('puts ./ before a file in the project’s own directory only, as Jest’s formatTestPath', async () => {
    const text = await written(defaultReporter, [
      { path: 'a.test.ts', tests: [{ path: ['t'] }] },
      { path: 'src/b.test.ts', tests: [{ path: ['t'] }] },
      { path: 'src/deep/c.test.ts', project: 'web', tests: [{ path: ['t'] }] },
    ])
    assert.match(text, /^PASS \.\/a\.test\.ts$/m)
    assert.match(text, /^PASS src\/b\.test\.ts$/m)
    assert.match(text, /^PASS web src\/deep\/c\.test\.ts$/m)
  })
})

describe('noStackTrace', () => {
  const failing: FileSpec = {
    path: 'f.test.ts',
    tests: [
      {
        path: ['t'],
        state: 'fail',
        errors: [
          error('boom', { stack: 'Error: boom\n    at Object.<anonymous> (f.test.ts:2:3)' }),
        ],
      },
    ],
  }

  test('leaves the frames out of a failure’s message', async () => {
    const plain = await written(defaultReporter, [failing])
    assert.match(plain, /at Object\.<anonymous>/)
    const text = await written(defaultReporter, [failing], { noStackTrace: true })
    assert.doesNotMatch(text, /at Object/)
    assert.match(text, /● t\n\n {4}boom\n/)
  })

  test('also leaves them out of the nested causes', async () => {
    const text = await written(
      defaultReporter,
      [
        {
          path: 'n.test.ts',
          tests: [
            {
              path: ['t'],
              state: 'fail',
              errors: [
                error('outer', {
                  cause: error('inner', { stack: 'Error: inner\n    at deep (x.ts:1:1)' }),
                }),
              ],
            },
          ],
        },
      ],
      { noStackTrace: true },
    )
    assert.match(text, /Caused by:\n {6}inner\n/)
    assert.doesNotMatch(text, /at deep/)
  })

  test('drops a library’s frames either way, as Jest does, and keeps the user’s', async () => {
    const text = await written(defaultReporter, [
      {
        path: 'lib.test.ts',
        tests: [
          {
            path: ['t'],
            state: 'fail',
            errors: [
              error('boom', {
                stack: [
                  'Error: boom',
                  '    at thrower (/p/node_modules/lib/index.js:1:1)',
                  '    at Object.<anonymous> (/p/lib.test.ts:2:3)',
                  '    at node:internal/process/task_queues:105:5',
                ].join('\n'),
              }),
            ],
          },
        ],
      },
    ])
    assert.match(text, /at Object\.<anonymous> \(\/p\/lib\.test\.ts:2:3\)/)
    assert.doesNotMatch(text, /node_modules|node:internal/)
  })
})

describe('the verbose reporter', () => {
  test('lists each test under its describe titles, with a mark and its time (cli/report-verbose)', async () => {
    const text = await written(verboseReporter, [
      {
        path: 'passes.test.ts',
        tests: [
          { path: ['math', 'adds'], durationMs: 3 },
          { path: ['math', 'nested', 'subtracts'], durationMs: 0.2 },
          { path: ['stands alone'], durationMs: 12 },
        ],
      },
    ])
    assert.equal(
      text.split('Test Suites')[0],
      [
        'PASS ./passes.test.ts',
        '  ✓ stands alone (12 ms)',
        '  math',
        '    ✓ adds (3 ms)',
        '    nested',
        '      ✓ subtracts',
        '',
        '',
      ].join('\n'),
    )
  })

  test('lists a suite’s own tests before its inner suites, skipped and todo after the others', async () => {
    const text = await written(verboseReporter, [
      {
        path: 'order.test.ts',
        tests: [
          { path: ['s', 'inner', 'deep'], durationMs: 0 },
          { path: ['s', 'first'], durationMs: 0 },
          { path: ['s', 'skipped one'], state: 'skip' },
          { path: ['s', 'second'], state: 'fail', errors: [error('no')], durationMs: 0 },
          { path: ['s', 'planned'], state: 'todo' },
        ],
      },
    ])
    assert.match(
      text,
      /FAIL \.\/order\.test\.ts\n {2}s\n {4}✓ first\n {4}✕ second\n {4}○ skipped skipped one\n {4}✎ todo planned\n {4}inner\n {6}✓ deep\n\n {2}● s › second\n/,
    )
  })

  test('keeps declaration order under expand, with plain titles for skipped and todo tests', async () => {
    const text = await written(
      verboseReporter,
      [
        {
          path: 'order.test.ts',
          tests: [
            { path: ['skipped one'], state: 'skip', durationMs: 0 },
            { path: ['first'], durationMs: 0 },
            { path: ['planned'], state: 'todo', durationMs: 0 },
          ],
        },
      ],
      { expand: true },
    )
    assert.match(
      text,
      /PASS \.\/order\.test\.ts\n {2}○ skipped one\n {2}✓ first\n {2}✎ planned\n\n/,
    )
  })

  test('leaves out a test that never ended, and the suite that held only such tests', async () => {
    const text = await written(verboseReporter, [
      {
        path: 'cut.test.ts',
        state: 'fail',
        errors: [error('stopped')],
        tests: [
          { path: ['done'], durationMs: 0 },
          { path: ['gone', 'never'], ran: false },
        ],
      },
    ])
    assert.match(text, /FAIL \.\/cut\.test\.ts\n {2}✓ done\n\n/)
    assert.doesNotMatch(text, /gone|never/)
  })

  test('prints the console output before the header, two spaces in, as Jest prints it live', async () => {
    const text = await written(verboseReporter, [
      { path: 'a.test.ts', tests: [{ path: ['t'], durationMs: 0 }] },
      CONSOLE_FILE,
    ])
    assert.match(
      text,
      /PASS \.\/a\.test\.ts\n {2}✓ t\n\n {2}console\.log\n {4}one\n\n {2}console\.warn\n {4}two\n {4}second line\n\n {2}console\.error\n {4}three\n\n {2}process\.stdout\n {4}raw\n\nPASS \.\/console\.test\.ts\n/,
    )
    assert.doesNotMatch(text, /● Console/)
  })

  test('prints no console output under silent', async () => {
    const text = await written(verboseReporter, [CONSOLE_FILE], { silent: true })
    assert.doesNotMatch(text, /console\.(log|warn|error)|process\.stdout/)
  })

  test('lists nothing for a file that failed to run, only its error', async () => {
    const text = await written(verboseReporter, [
      { path: 'broken.test.ts', state: 'fail', errors: [error('cannot load')] },
    ])
    assert.match(text, /^FAIL \.\/broken\.test\.ts\n {2}● Test suite failed to run\n/)
  })
})

describe('report.listTestsForSingleFile (Jest turns --verbose on for a run of one test file)', () => {
  const one: FileSpec = {
    path: 'a.test.ts',
    tests: [
      { path: ['group', 'works'], durationMs: 3 },
      { path: ['later'], state: 'skip' },
    ],
    console: [{ text: 'hello\n' }],
  }
  const two: FileSpec = { path: 'b.test.ts', tests: [{ path: ['t'] }] }
  const jest: Partial<TextReporterOptions> = { report: JEST_REPORT }

  test('lists the tests of the one file, console first, as verbose does', async () => {
    const asked = await written(defaultReporter, [one], jest)
    const verbose = await written(verboseReporter, [one])
    assert.equal(asked, verbose)
    // The console block first (cli/report-single-file), then the root's own tests, then the suites.
    assert.match(
      asked,
      /^ {2}console\.log\n {4}hello\n\nPASS \.\/a\.test\.ts\n {2}○ skipped later\n {2}group\n {4}✓ works \(3 ms\)\n\n/,
    )
  })

  test('does nothing under a policy that is off (the neutral and Vitest value)', async () => {
    const plain = await written(defaultReporter, [one])
    assert.doesNotMatch(plain, /✓/)
    assert.equal(await written(defaultReporter, [one], { report: NEUTRAL_REPORT }), plain)
  })

  test('is off under silent and under verbose: false, Jest’s two exceptions', async () => {
    for (const exception of [{ silent: true }, { verbose: false as const }]) {
      const text = await written(defaultReporter, [one], { ...jest, ...exception })
      assert.doesNotMatch(text, /✓/, JSON.stringify(exception))
    }
  })

  test('does nothing for a run of two files, or of none', async () => {
    const plain = await written(defaultReporter, [one, two])
    assert.equal(await written(defaultReporter, [one, two], jest), plain)
    assert.doesNotMatch(plain, /✓/)
    const empty = await written(defaultReporter, [])
    assert.equal(await written(defaultReporter, [], jest), empty)
  })

  test('counts the files run:start announces, so a second file the run never reached still makes two', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: JEST_REPORT })])
    await playRun(bus, [one], { notRun: ['never.test.ts'] })
    assert.doesNotMatch(out.text(), /✓/)
  })

  test('leaves the dot and agent reporters alone', async () => {
    for (const make of [dotReporter, agentReporter]) {
      const plain = await written(make, [one])
      assert.equal(await written(make, [one], jest), plain)
    }
  })

  test('starts over at each run:start: one file, then two', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: JEST_REPORT })])
    await playRun(bus, [one])
    const first = out.text().length
    await playRun(bus, [one, two])
    assert.match(out.text().slice(0, first), /✓ works/)
    assert.doesNotMatch(out.text().slice(first), /✓/)
  })
})

describe('the agent reporter', () => {
  test('prints nothing for a passing run but the totals', async () => {
    const text = await written(agentReporter, [
      { path: 'a.test.ts', tests: [{ path: ['t'] }] },
      CONSOLE_FILE,
    ])
    assert.equal(
      text,
      [
        'Test Suites: 2 passed, 2 total',
        'Tests:       2 passed, 2 total',
        'Time:        1.234 s',
        '',
      ].join('\n'),
    )
  })

  test('prints a failed file’s header and failures, and nothing for a skipped or passing one', async () => {
    const text = await written(agentReporter, [
      { path: 'ok.test.ts', tests: [{ path: ['t'] }] },
      {
        path: 'bad.test.ts',
        tests: [{ path: ['g', 'x'], state: 'fail', errors: [error('nope')] }],
      },
      { path: 'skip.test.ts', state: 'skip', tests: [{ path: ['t'], state: 'skip' }] },
    ])
    assert.match(
      text,
      /^FAIL \.\/bad\.test\.ts\n {2}● g › x\n\n {4}nope\n\nTest Suites: 1 failed, 1 skipped, 1 passed, 2 of 3 total/,
    )
    assert.doesNotMatch(text, /ok\.test|skip\.test/)
  })

  test('never draws the live block, even when asked', async () => {
    const text = await written(agentReporter, [{ path: 'a.test.ts', tests: [{ path: ['t'] }] }], {
      live: true,
    })
    assert.doesNotMatch(text, new RegExp(`${ESC}\\[\\d+F`))
    assert.doesNotMatch(text, /RUNS/)
  })
})

describe('the dot reporter', () => {
  test('prints a character per test as it ends, then the failed files and the totals', async () => {
    const text = await written(dotReporter, [
      {
        path: 'a.test.ts',
        tests: [
          { path: ['p'] },
          { path: ['f'], state: 'fail', errors: [error('boom')] },
          { path: ['s'], state: 'skip' },
          { path: ['t'], state: 'todo' },
        ],
      },
    ])
    assert.equal(
      text,
      [
        '.F--',
        '',
        'FAIL ./a.test.ts',
        '  ● f',
        '',
        '    boom',
        '',
        'Test Suites: 1 failed, 1 total',
        'Tests:       1 failed, 2 skipped, 1 passed, 4 total',
        'Time:        1.234 s',
        '',
      ]
        .join('\n')
        .replace('2 skipped, 1 passed', '1 skipped, 1 todo, 1 passed'),
    )
  })

  test('wraps at the terminal’s width and ends the last line', async () => {
    const text = await written(
      dotReporter,
      [{ path: 'a.test.ts', tests: Array.from({ length: 7 }, (_, i) => ({ path: [`t${i}`] })) }],
      { columns: 3 },
    )
    assert.match(text, /^\.\.\.\n\.\.\.\n\.\n\nTest Suites: 1 passed, 1 total\n/)
  })

  test('does not add a line when the dots fill one exactly', async () => {
    const text = await written(
      dotReporter,
      [{ path: 'a.test.ts', tests: Array.from({ length: 3 }, (_, i) => ({ path: [`t${i}`] })) }],
      { columns: 3 },
    )
    assert.match(text, /^\.\.\.\n\nTest Suites:/)
  })

  test('colours the characters', async () => {
    const text = await written(
      dotReporter,
      [
        {
          path: 'a.test.ts',
          tests: [{ path: ['p'] }, { path: ['f'], state: 'fail', errors: [error('x')] }],
        },
      ],
      { colour: true },
    )
    assert.ok(text.startsWith(`${ESC}[32m.${ESC}[39m${ESC}[31mF${ESC}[39m\n`))
  })

  test('prints no dots for a run with no tests, only the totals', async () => {
    const text = await written(dotReporter, [])
    assert.equal(
      text,
      ['Test Suites: 0 total', 'Tests:       0 total', 'Time:        1.234 s', ''].join('\n'),
    )
  })

  test('never draws the live block, whose redraw would erase the row of dots', async () => {
    const text = await written(
      dotReporter,
      [{ path: 'a.test.ts', tests: [{ path: ['t'] }, { path: ['u'] }] }],
      { live: true, columns: 40 },
    )
    assert.doesNotMatch(text, new RegExp(`${ESC}\\[\\d+F`))
    assert.doesNotMatch(text, /RUNS/)
    assert.match(text, /^\.\.\n\nTest Suites: 1 passed, 1 total\n/)
  })

  test('ends the row of dots before an error’s block, which starts under a blank line', async () => {
    const out = output()
    const bus = createReporterBus([dotReporter({ stream: out, report: REPORT, columns: 10 })])
    const file = buildFile({
      path: 'a.test.ts',
      tests: [
        { path: ['p'] },
        { path: ['f'], state: 'fail', errors: [error('boom')] },
        { path: ['q'] },
      ],
    })
    await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [
      file.info,
    ])
    await bus.emit('file:start', file.info, 0)
    await bus.emit('file:collected', file.info, collectedEvent(file))
    for (const [index, { task, spec }] of file.tests.entries()) {
      if (index === 1) await bus.emit('error', error('mid-run'), 'coordinator')
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    await bus.emit('file:end', file.result)
    await bus.emit('run:end', {
      reason: 'failed',
      files: [file.result],
      unhandled: [],
      durationMs: 1,
    })
    const text = out.text()
    assert.match(
      text,
      /^\.\n\n {2}● Run error\n\n {4}mid-run\n\nF\.\n\nFAIL \.\/a\.test\.ts\n/,
      text,
    )
  })

  test('takes a width of zero, or none that makes sense, for the default 80', async () => {
    const tests = Array.from({ length: 85 }, (_, i) => ({ path: [`t${i}`] }))
    for (const columns of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const text = await written(dotReporter, [{ path: 'a.test.ts', tests }], { columns })
      assert.match(text, /^\.{80}\n\.{5}\n\nTest Suites:/, `columns ${columns}`)
    }
  })

  test('starts its dots over at each run:start', async () => {
    const out = output()
    const reporter = dotReporter({ stream: out, report: REPORT, columns: 3 })
    const bus = createReporterBus([reporter])
    await playRun(bus, [{ path: 'a.test.ts', tests: [{ path: ['a'] }, { path: ['b'] }] }])
    const first = out.text().length
    await playRun(bus, [{ path: 'b.test.ts', tests: [{ path: ['a'] }, { path: ['b'] }] }])
    assert.match(out.text().slice(first), /^\.\.\n\n/)
  })
})

describe('the live view', () => {
  const live = { live: true, columns: 40 } as const

  test('draws the running file, then replaces it with the file’s result', async () => {
    const text = await written(
      defaultReporter,
      [{ path: 'a.test.ts', tests: [{ path: ['t'] }] }],
      live,
    )
    assert.equal(
      text,
      [
        'RUNS ./a.test.ts\n',
        `${ESC}[1F${ESC}[0JPASS ./a.test.ts\n`,
        `\nTest Suites: 1 passed, 1 total\nTests:       1 passed, 1 total\nTime:        1.234 s\n`,
      ].join(''),
    )
  })

  test('erases the block before any text, so nothing lands in the middle of it', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: REPORT, ...live })])
    const file = { path: 'a.test.ts', tests: [{ path: ['t'] }] }
    await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
    await bus.emit('file:start', { fileId: 'a' as never, path: file.path, project: '' }, 0)
    await bus.emit('error', error('mid-run'), 'coordinator')
    const text = out.text()
    assert.ok(text.indexOf('mid-run') > text.indexOf(`${ESC}[1F${ESC}[0J`), text)
    // And draws the block again below it.
    assert.ok(text.lastIndexOf('RUNS') > text.indexOf('mid-run'), text)
  })

  test('names up to four running files, then counts the rest, and fits a name to the width', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: REPORT, ...live })])
    await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
    for (let i = 0; i < 6; i++) {
      await bus.emit(
        'file:start',
        { fileId: `f${i}` as never, path: `dir/file-${i}.test.ts`, project: '' },
        0,
      )
    }
    await bus.emit(
      'file:start',
      { fileId: 'long' as never, path: `${'x/'.repeat(30)}z.test.ts`, project: '' },
      0,
    )
    const last = out.text().split(`${ESC}[`).at(-1) ?? ''
    assert.equal((last.match(/RUNS/g) ?? []).length, 4)
    assert.match(last, /\.\.\. and 3 more/)
    const earlier = out.text()
    assert.doesNotMatch(earlier, new RegExp(`RUNS [^\\n]{${40}}`))
  })

  test('leaves the screen clean at the end of the run', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: REPORT, ...live })])
    await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
    await bus.emit('file:start', { fileId: 'a' as never, path: 'a.test.ts', project: '' }, 0)
    await bus.emit('run:end', { reason: 'interrupted', files: [], unhandled: [], durationMs: 1 })
    const after = out.text().slice(out.text().lastIndexOf('RUNS'))
    assert.match(after, new RegExp(`${ESC}\\[1F${ESC}\\[0J`))
    assert.doesNotMatch(after.slice(after.indexOf('Test Suites')), /RUNS/)
  })

  test('draws nothing without live, so a pipe never sees an escape sequence', async () => {
    const text = await written(defaultReporter, [{ path: 'a.test.ts', tests: [{ path: ['t'] }] }])
    assert.doesNotMatch(text, new RegExp(ESC))
    assert.doesNotMatch(text, /RUNS/)
  })
})

describe('colour', () => {
  test('colours the badge, the failure title and the totals, and plain text has none of it', async () => {
    const files: FileSpec[] = [
      { path: 'a.test.ts', tests: [{ path: ['t'] }] },
      { path: 'b.test.ts', tests: [{ path: ['u'], state: 'fail', errors: [error('x')] }] },
    ]
    const coloured = await written(defaultReporter, files, { colour: true })
    assert.match(coloured, new RegExp(`${ESC}\\[32m PASS ${ESC}\\[39m`))
    assert.match(coloured, new RegExp(`${ESC}\\[31m FAIL ${ESC}\\[39m`))
    assert.match(coloured, new RegExp(`${ESC}\\[1m  ● ${ESC}\\[22m${ESC}\\[1mu${ESC}\\[22m`))
    assert.match(coloured, new RegExp(`${ESC}\\[1m${ESC}\\[31m1 failed${ESC}\\[39m${ESC}\\[22m`))
    assert.match(coloured, new RegExp(`${ESC}\\[1mTest Suites:${ESC}\\[22m `))
    const plain = await written(defaultReporter, files)
    assert.equal(
      coloured
        .replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
        .replaceAll(' PASS ', 'PASS')
        .replaceAll(' FAIL ', 'FAIL'),
      plain,
    )
  })
})
