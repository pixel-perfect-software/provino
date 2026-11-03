// T5.3 acceptance for what happens after collection: the empty-describe rule, `.only` and
// `allowOnly`, the two focus algorithms (`focus.scope`) with `focus.insideSkip` and
// `status.todoUnderSkip`, the name, id and line filters, and the task list itself. Each policy value
// is set on its own over the neutral base.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FileState } from '../internal/model.ts'
import {
  type CoreOverrides,
  locateMarker,
  policyWith,
  runScript,
  type Script,
  type ScriptRun,
  testNamed,
} from '../internal/test-support.ts'
import { createApi, type RuntimeApi } from './api.ts'
import { Collector } from './collector.ts'
import { type FinalizeOptions, fileIdOf, finalize } from './finalize.ts'
import { newFileState, walk } from './nodes.ts'

const SCOPES = ['file', 'suite'] as const

/** The error codes a file failed with. */
function fileCodes(run: ScriptRun): Array<string | undefined> {
  return run.file.errors.map((error) => error.code)
}

/** Each test's skip reason by full name (only the skipped ones). */
function skipReasons(run: ScriptRun): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(run.results)
      .filter(([, result]) => result.state === 'skip')
      .map(([name, result]) => [name, result.skipReason]),
  )
}

describe('collect.emptyDescribe', () => {
  const script: Script = ({ describe, test, beforeEach, afterAll }) => {
    describe('empty with hooks', () => {
      beforeEach(() => {})
      afterAll(() => {})
    })
    describe('empty without hooks', () => {})
    describe('skipped and empty', { skip: true }, () => {})
    test('real', () => {})
  }

  test('allow reports nothing for a describe with no tests', async () => {
    const run = await runScript(script, { collect: { emptyDescribe: 'allow' } })
    assert.deepEqual(run.file.errors, [])
    assert.equal(run.file.state, 'pass')
    assert.equal(run.suites['empty with hooks']?.state, 'pass')
  })

  test('fail-file-if-hooks fails the file once for each hook in a describe with no tests', async () => {
    const run = await runScript(script, { collect: { emptyDescribe: 'fail-file-if-hooks' } })
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_EMPTY_DESCRIBE', 'CORE_EMPTY_DESCRIBE'])
    assert.match(run.file.errors[0]?.message ?? '', /beforeEach/)
    assert.match(run.file.errors[1]?.message ?? '', /afterAll/)
  })

  test('fail-file-if-hooks leaves a describe with no tests and no hooks alone, and still runs the other tests', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('empty without hooks', () => {})
        test('real', () => {})
      },
      { collect: { emptyDescribe: 'fail-file-if-hooks' } },
    )
    assert.equal(run.file.state, 'pass')
    assert.deepEqual(run.states, { real: 'pass' })
  })

  test('fail-file-if-hooks treats a describe that only holds empty describes as empty', async () => {
    const run = await runScript(
      ({ describe, beforeAll }) => {
        describe('outer', () => {
          beforeAll(() => {})
          describe('inner', () => {})
        })
      },
      { collect: { emptyDescribe: 'fail-file-if-hooks' } },
    )
    assert.deepEqual(fileCodes(run), ['CORE_EMPTY_DESCRIBE'])
  })

  test('fail-suite fails each empty describe that would run, and the file with it', async () => {
    const run = await runScript(script, { collect: { emptyDescribe: 'fail-suite' } })
    assert.equal(run.suites['empty with hooks']?.state, 'fail')
    assert.equal(run.suites['empty with hooks']?.errors[0]?.code, 'CORE_EMPTY_DESCRIBE')
    assert.equal(run.suites['empty without hooks']?.state, 'fail')
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(run.file.errors, [])
  })

  test('fail-suite leaves an empty skipped describe alone', async () => {
    const run = await runScript(script, { collect: { emptyDescribe: 'fail-suite' } })
    assert.equal(run.suites['skipped and empty']?.state, 'skip')
  })

  test('fail-suite collapses a describe none of whose children runs to skip, instead of failing it', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('holds a skipped describe', () => {
          describe.skip('empty', () => {})
        })
        describe('holds skipped tests', () => {
          test.skip('s', () => {})
          test.todo('later')
        })
        test('real', () => {})
      },
      { collect: { emptyDescribe: 'fail-suite' } },
    )
    assert.equal(run.suites['holds a skipped describe']?.state, 'skip')
    assert.deepEqual(run.suites['holds a skipped describe']?.errors, [])
    assert.equal(run.suites['holds skipped tests']?.state, 'skip')
    assert.equal(run.file.state, 'pass')
  })

  test('fail-suite still fails a describe that only holds an empty describe that runs', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('outer', () => {
          describe('inner', () => {})
        })
        test('real', () => {})
      },
      { collect: { emptyDescribe: 'fail-suite' } },
    )
    assert.equal(run.suites['outer > inner']?.errors[0]?.code, 'CORE_EMPTY_DESCRIBE')
    assert.equal(run.suites.outer?.errors[0]?.code, 'CORE_EMPTY_DESCRIBE')
  })
})

describe('allowOnly', () => {
  const script: Script = ({ test }, step) => {
    test('other', () => step('other'))
    test.only('focused', () => step('focused'))
  }

  for (const [allowOnly, ci] of [
    ['always', true],
    ['always', false],
    ['not-in-ci', false],
  ] as const) {
    test(`${allowOnly} with ci ${ci} runs the .only test and skips the rest`, async () => {
      const run = await runScript(script, { allowOnly }, { ci })
      assert.deepEqual(run.states, { other: 'skip', focused: 'pass' })
      assert.deepEqual(run.trace, ['focused'])
      assert.equal(run.file.state, 'pass')
    })
  }

  test('not-in-ci with ci true fails the .only test with CORE_ONLY_NOT_ALLOWED, without running it', async () => {
    const run = await runScript(script, { allowOnly: 'not-in-ci' }, { ci: true })
    assert.equal(run.states.focused, 'fail')
    assert.equal(run.results.focused?.errors[0]?.code, 'CORE_ONLY_NOT_ALLOWED')
    assert.deepEqual(run.trace, [])
    assert.equal(run.file.state, 'fail')
  })

  test('not-in-ci with ci true fails a describe.only and skips what is inside it', async () => {
    const run = await runScript(
      ({ describe, test }, step) => {
        describe.only('focused', () => {
          test('inside', () => step('inside'))
        })
      },
      { allowOnly: 'not-in-ci' },
      { ci: true },
    )
    assert.equal(run.suites.focused?.state, 'fail')
    assert.equal(run.suites.focused?.errors[0]?.code, 'CORE_ONLY_NOT_ALLOWED')
    assert.equal(run.states['focused > inside'], 'skip')
    assert.deepEqual(run.trace, [])
  })

  for (const scope of SCOPES) {
    test(`${scope} scope: not-in-ci with ci true leaves a .only in a skipped describe alone, since it never runs`, async () => {
      const run = await runScript(
        ({ describe, test }) => {
          describe.skip('skipped', () => {
            describe.only('focused', () => {
              test('t', () => {})
            })
          })
        },
        { allowOnly: 'not-in-ci', focus: { scope, insideSkip: 'skipped' } },
        { ci: true },
      )
      assert.equal(run.suites['skipped > focused']?.state, 'skip')
      assert.deepEqual(run.suites['skipped > focused']?.errors, [])
      assert.deepEqual(run.file.errors, [])
    })
  }

  test('not-in-ci with ci true leaves a file with no .only alone', async () => {
    const run = await runScript(
      ({ test }) => {
        test('plain', () => {})
      },
      { allowOnly: 'not-in-ci' },
      { ci: true },
    )
    assert.deepEqual(run.states, { plain: 'pass' })
  })
})

describe('focus.scope', () => {
  for (const scope of SCOPES) {
    test(`${scope}: a .only test skips the tests around it, with the reason only-filter`, async () => {
      const run = await runScript(
        ({ describe, test }) => {
          describe('a', () => {
            test('focused', { only: true }, () => {})
            test('sibling', () => {})
          })
          describe('b', () => {
            test('other', () => {})
          })
          test('top level', () => {})
        },
        { focus: { scope } },
      )
      assert.deepEqual(run.states, {
        'a > focused': 'pass',
        'a > sibling': 'skip',
        'b > other': 'skip',
        'top level': 'skip',
      })
      assert.equal(run.results['a > sibling']?.skipReason, 'only-filter')
      assert.equal(run.results['top level']?.skipReason, 'only-filter')
      // A test inside a describe the filter dropped was skipped by the filter too.
      assert.equal(run.results['b > other']?.skipReason, 'only-filter')
    })

    test(`${scope}: a describe.only runs every test inside it, nested describes included`, async () => {
      const run = await runScript(
        ({ describe, test }) => {
          describe.only('focused', () => {
            test('a', () => {})
            describe('nested', () => {
              test('b', () => {})
            })
          })
          describe('other', () => {
            test('c', () => {})
          })
        },
        { focus: { scope } },
      )
      assert.deepEqual(run.states, {
        'focused > a': 'pass',
        'focused > nested > b': 'pass',
        'other > c': 'skip',
      })
    })
  }

  // A describe.only that also holds a direct test.only: jest-circus narrows to that test but lets
  // a nested describe inherit the describe's .only; Vitest narrows every child of that suite.
  const mixed: Script = ({ describe, test }, step) => {
    describe.only('outer', () => {
      test.only('direct', () => step('direct'))
      test('plain', () => step('plain'))
      describe('nested', () => {
        test('inner', () => step('inner'))
      })
    })
    test('outside', () => step('outside'))
  }

  test('file: a describe.only with a direct test.only still runs a nested describe without .only', async () => {
    const run = await runScript(mixed, { focus: { scope: 'file' } })
    assert.deepEqual(run.states, {
      'outer > direct': 'pass',
      'outer > plain': 'skip',
      'outer > nested > inner': 'pass',
      outside: 'skip',
    })
    assert.deepEqual(run.trace, ['direct', 'inner'])
  })

  test('suite: a describe.only with a direct test.only skips a nested describe without .only', async () => {
    const run = await runScript(mixed, { focus: { scope: 'suite' } })
    assert.deepEqual(run.states, {
      'outer > direct': 'pass',
      'outer > plain': 'skip',
      'outer > nested > inner': 'skip',
      outside: 'skip',
    })
    assert.deepEqual(run.trace, ['direct'])
  })
})

describe('focus.insideSkip', () => {
  // A describe.only inside a describe.skip.
  const nested: Script = ({ describe, test }) => {
    describe.skip('outer', () => {
      test('plain', () => {})
      describe.only('inner', () => {
        test('focused', () => {})
      })
    })
  }

  for (const scope of SCOPES) {
    test(`${scope} scope, runs: a describe.only inside a describe.skip still runs`, async () => {
      const run = await runScript(nested, { focus: { scope, insideSkip: 'runs' } })
      assert.deepEqual(run.states, { 'outer > plain': 'skip', 'outer > inner > focused': 'pass' })
    })

    test(`${scope} scope, skipped: a describe.only inside a describe.skip is skipped`, async () => {
      const run = await runScript(nested, { focus: { scope, insideSkip: 'skipped' } })
      assert.deepEqual(run.states, { 'outer > plain': 'skip', 'outer > inner > focused': 'skip' })
      assert.equal(run.results['outer > inner > focused']?.skipReason, 'modifier')
    })
  }

  // Vitest's tree walk also lets a test.only that is a direct child of the skipped describe run.
  const direct: Script = ({ describe, test }) => {
    describe.skip('outer', () => {
      test.only('focused', () => {})
      test('plain', () => {})
    })
  }

  test('suite scope, runs: a test.only directly inside a describe.skip runs', async () => {
    const run = await runScript(direct, { focus: { scope: 'suite', insideSkip: 'runs' } })
    assert.deepEqual(run.states, { 'outer > focused': 'pass', 'outer > plain': 'skip' })
  })

  test('suite scope, skipped: a test.only directly inside a describe.skip is skipped', async () => {
    const run = await runScript(direct, { focus: { scope: 'suite', insideSkip: 'skipped' } })
    assert.deepEqual(run.states, { 'outer > focused': 'skip', 'outer > plain': 'skip' })
  })
})

describe('status.todoUnderSkip', () => {
  const script: Script = ({ describe, test }) => {
    describe.skip('skipped', () => {
      test.todo('later')
      test('plain', () => {})
    })
    test.todo('top level todo')
  }

  for (const scope of SCOPES) {
    test(`${scope} scope, skipped: a todo under a describe.skip is reported skipped`, async () => {
      const run = await runScript(script, {
        focus: { scope },
        status: { todoUnderSkip: 'skipped' },
      })
      assert.deepEqual(run.states, {
        'skipped > later': 'skip',
        'skipped > plain': 'skip',
        'top level todo': 'todo',
      })
    })

    test(`${scope} scope, todo: a todo under a describe.skip stays a todo`, async () => {
      const run = await runScript(script, { focus: { scope }, status: { todoUnderSkip: 'todo' } })
      assert.deepEqual(run.states, {
        'skipped > later': 'todo',
        'skipped > plain': 'skip',
        'top level todo': 'todo',
      })
    })
  }
})

describe('skip reasons under a skipped describe', () => {
  for (const scope of SCOPES) {
    test(`${scope} scope: tests under describe.skipIf(true) take its reason, condition; their own .skip stays modifier`, async () => {
      const run = await runScript(
        ({ describe, test }) => {
          describe.skipIf(true)('conditional', () => {
            test('t', () => {})
            test.skip('own skip', () => {})
            describe('inner', () => {
              test('u', () => {})
            })
          })
        },
        { focus: { scope } },
      )
      assert.deepEqual(skipReasons(run), {
        'conditional > t': 'condition',
        'conditional > own skip': 'modifier',
        'conditional > inner > u': 'condition',
      })
    })
  }
})

describe('nameSeparator and testNamePatternFlags', () => {
  const script: Script = ({ describe, test }) => {
    describe('outer', () => {
      test('inner one', () => {})
      test('other', () => {})
    })
  }

  test('the pattern is matched against the full name joined with nameSeparator', async () => {
    const run = await runScript(
      script,
      { nameSeparator: ' > ' },
      { testNamePattern: 'outer > inner' },
    )
    assert.deepEqual(run.states, { 'outer > inner one': 'pass', 'outer > other': 'skip' })
  })

  test('another nameSeparator changes what a pattern can match', async () => {
    const spaced = await runScript(
      script,
      { nameSeparator: ' ' },
      { testNamePattern: 'outer inner' },
    )
    assert.deepEqual(spaced.states, { 'outer > inner one': 'pass', 'outer > other': 'skip' })
    const arrowed = await runScript(
      script,
      { nameSeparator: ' > ' },
      { testNamePattern: 'outer inner' },
    )
    assert.deepEqual(arrowed.states, { 'outer > inner one': 'skip', 'outer > other': 'skip' })
  })

  test('the test sees its own full name joined with nameSeparator', async () => {
    let context: unknown
    const run = await runScript(
      ({ describe, test }) => {
        describe('outer', () => {
          test('inner', (ctx) => {
            context = ctx
          })
        })
      },
      { nameSeparator: ' / ' },
    )
    assert.equal(run.runtime.lazyHost.runOf(context as object)?.ctx.task.fullName, 'outer / inner')
  })

  test('an empty testNamePatternFlags makes the pattern case-sensitive', async () => {
    const run = await runScript(
      script,
      { testNamePatternFlags: '' },
      { testNamePattern: 'OUTER > INNER' },
    )
    assert.deepEqual(run.states, { 'outer > inner one': 'skip', 'outer > other': 'skip' })
  })

  test('testNamePatternFlags "i" makes it case-insensitive', async () => {
    const run = await runScript(
      script,
      { testNamePatternFlags: 'i' },
      { testNamePattern: 'OUTER > INNER' },
    )
    assert.deepEqual(run.states, { 'outer > inner one': 'pass', 'outer > other': 'skip' })
  })

  test('a test the pattern leaves out is skipped with the reason name-filter', async () => {
    const run = await runScript(script, {}, { testNamePattern: 'inner' })
    assert.deepEqual(skipReasons(run), { 'outer > other': 'name-filter' })
  })

  test('a global RegExp is matched from the start for every test', async () => {
    const run = await runScript(
      ({ test }) => {
        test('t1', () => {})
        test('t2', () => {})
        test('t3', () => {})
      },
      {},
      { testNamePattern: /t\d/g },
    )
    assert.deepEqual(run.states, { t1: 'pass', t2: 'pass', t3: 'pass' })
  })
})

describe('testIds', () => {
  const script: Script = ({ test }, step) => {
    test('a', () => step('a'))
    test('b', () => step('b'))
    test('c', () => step('c'))
  }

  test('only the tests whose ids are listed run, the rest are skipped with the reason name-filter', async () => {
    const first = await runScript(script)
    const run = await runScript(script, {}, { testIds: [testNamed(first, 'b').id] })
    assert.deepEqual(run.states, { a: 'skip', b: 'pass', c: 'skip' })
    assert.deepEqual(skipReasons(run), { a: 'name-filter', c: 'name-filter' })
    assert.deepEqual(run.trace, ['b'])
  })

  test('a name pattern and testIds both have to match', async () => {
    const first = await runScript(script)
    const ids = [testNamed(first, 'a').id, testNamed(first, 'b').id]
    const run = await runScript(script, {}, { testIds: ids, testNamePattern: 'b' })
    assert.deepEqual(run.states, { a: 'skip', b: 'pass', c: 'skip' })
  })
})

describe('lines', () => {
  const file = import.meta.filename
  const lineOf = (marker: string, token: string): number =>
    locateMarker(file, `// @marker:${marker}`, token).line

  /**
   * Collects `script` as the file at `path` (this test file unless given) and finalizes it with
   * `lines`. The runtime's test files are inline scripts at another path, so this drives the
   * collector directly: a location only counts when it is in the test file.
   */
  const collectLines = async (
    script: (api: RuntimeApi) => void,
    lines: readonly number[],
    options: {
      readonly overrides?: CoreOverrides
      readonly path?: string
      readonly finalize?: Partial<FinalizeOptions>
    } = {},
  ): Promise<{
    readonly file: FileState
    readonly modes: Record<string, string>
    readonly reasons: Record<string, string | undefined>
  }> => {
    const policy = policyWith(options.overrides)
    const collector = new Collector({
      policy,
      formatEachTitle: (name) => name,
      locations: true,
      onLateRegistration: () => {},
    })
    const state = newFileState(
      options.path ?? file,
      'finalize.test.ts',
      new AbortController().signal,
    )
    await collector.collect(state, async () => script(createApi(collector)))
    collector.close(state)
    finalize(state, {
      policy,
      projectName: '',
      ci: false,
      testNamePattern: undefined,
      testIds: undefined,
      lines: new Set(lines),
      ...options.finalize,
    })
    const modes: Record<string, string> = {}
    const reasons: Record<string, string | undefined> = {}
    for (const node of walk(state.root)) {
      if (node.type !== 'test') continue
      const name = node.fullName.join(' > ')
      modes[name] = node.mode
      reasons[name] = node.skipReason
    }
    return { file: state, modes, reasons }
  }

  const script = ({ describe, test }: RuntimeApi): void => {
    // @marker:first
    test('first', () => {})
    // @marker:second
    test('second', () => {})
    // @marker:suite
    describe('suite', () => {
      test('in suite 1', () => {})
      test('in suite 2', () => {})
    })
  }

  for (const scope of SCOPES) {
    const overrides = { focus: { scope } }

    test(`${scope} scope: a line that holds a test runs that test and skips the rest, with the reason name-filter`, async () => {
      const run = await collectLines(script, [lineOf('first', 'test(')], { overrides })
      assert.deepEqual(run.modes, {
        first: 'run',
        second: 'skip',
        'suite > in suite 1': 'skip',
        'suite > in suite 2': 'skip',
      })
      assert.equal(run.reasons.second, 'name-filter')
      assert.deepEqual(run.file.errors, [])
    })

    test(`${scope} scope: a line that holds a describe runs every test inside it`, async () => {
      const run = await collectLines(script, [lineOf('suite', 'describe(')], { overrides })
      assert.deepEqual(run.modes, {
        first: 'skip',
        second: 'skip',
        'suite > in suite 1': 'run',
        'suite > in suite 2': 'run',
      })
    })

    test(`${scope} scope: a matched test runs even when its own .skip or a .only elsewhere would skip it`, async () => {
      const run = await collectLines(
        ({ test }) => {
          test.only('focused', () => {})
          // @marker:skipped-on-line
          test.skip('skipped', () => {})
        },
        [lineOf('skipped-on-line', 'test.skip(')],
        { overrides },
      )
      assert.deepEqual(run.modes, { focused: 'skip', skipped: 'run' })
      assert.equal(run.reasons.skipped, undefined)
    })

    test(`${scope} scope: a matched describe.skip runs, with everything under it`, async () => {
      const run = await collectLines(
        ({ describe, test }) => {
          // @marker:skipped-describe
          describe.skip('skipped', () => {
            test('t', () => {})
            test.skip('own skip', () => {})
          })
        },
        [lineOf('skipped-describe', 'describe.skip(')],
        { overrides },
      )
      assert.deepEqual(run.modes, { 'skipped > t': 'run', 'skipped > own skip': 'run' })
    })

    test(`${scope} scope: a line inside a skipped describe is not found`, async () => {
      const run = await collectLines(
        ({ describe, test }) => {
          describe.skip('skipped', () => {
            // @marker:inside-skip
            test('t', () => {})
          })
        },
        [lineOf('inside-skip', 'test(')],
        { overrides },
      )
      assert.equal(run.modes['skipped > t'], 'skip')
      assert.match(
        (run.file.errors[0] as Error | undefined)?.message ?? '',
        /No test found in .* in line \d+/,
      )
    })
  }

  test('a matched test the name pattern leaves out is still skipped', async () => {
    const run = await collectLines(script, [lineOf('suite', 'describe(')], {
      finalize: { testNamePattern: /in suite 1/ },
    })
    assert.equal(run.modes['suite > in suite 1'], 'run')
    assert.equal(run.modes['suite > in suite 2'], 'skip')
    assert.equal(run.reasons['suite > in suite 2'], 'name-filter')
  })

  test('a location in another file never matches', async () => {
    const run = await collectLines(script, [lineOf('first', 'test(')], {
      path: '/project/other.test.ts',
    })
    assert.equal(run.modes.first, 'skip')
    assert.deepEqual(
      run.file.errors.map((error) => (error as { code?: string }).code),
      ['CORE_INVALID_ARGUMENT'],
    )
  })

  test('several lines run the union of their tests', async () => {
    const run = await collectLines(script, [lineOf('second', 'test('), lineOf('first', 'test(')])
    assert.equal(run.modes.first, 'run')
    assert.equal(run.modes.second, 'run')
    assert.equal(run.modes['suite > in suite 1'], 'skip')
  })

  test('a line with no test fails the file with CORE_INVALID_ARGUMENT naming the line', async () => {
    const run = await runScript(
      ({ test }) => {
        test('first', () => {})
      },
      {},
      { locations: true, lines: [1] },
    )
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
    assert.match(run.file.errors[0]?.message ?? '', /line 1\b/)
    assert.equal(run.states.first, 'skip')
  })

  test('only the lines with no test are named, when others match', async () => {
    const run = await collectLines(script, [lineOf('first', 'test('), 1, 2])
    assert.match((run.file.errors[0] as Error | undefined)?.message ?? '', /lines 1, 2\b/)
    assert.equal(run.modes.first, 'run')
  })
})

describe('the task list', () => {
  test('lists the file first, then each parent before its children, in declaration order', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('a', () => {
        test('one', () => {})
        describe('b', () => {
          test('two', () => {})
        })
        test('three', () => {})
      })
      test('top', () => {})
    })
    assert.deepEqual(
      run.tasks.map((task) => task.name),
      ['script.test.ts', 'a', 'one', 'b', 'two', 'three', 'top'],
    )
  })

  test('a parent lists its children by id, in declaration order', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('a', () => {
        test('one', () => {})
        test('two', () => {})
      })
    })
    const suite = run.tasks.find((task) => task.type === 'suite')
    assert.equal(suite?.type, 'suite')
    assert.deepEqual(suite?.children, [testNamed(run, 'a > one').id, testNamed(run, 'a > two').id])
    const [file] = run.tasks
    assert.equal(file?.type === 'file' && file.children[0], suite?.id)
  })

  test('the declared mode, not the one focus gave it, is what the tree carries', async () => {
    const run = await runScript(({ test }) => {
      test('other', () => {})
      test.only('focused', () => {})
    })
    assert.equal(testNamed(run, 'other').mode, 'run')
    assert.equal(testNamed(run, 'focused').mode, 'only')
    assert.equal(run.states.other, 'skip')
  })
})

describe('fileIdOf', () => {
  test('is the same for the same project and path', () => {
    assert.equal(fileIdOf('web', 'a/b.test.ts'), fileIdOf('web', 'a/b.test.ts'))
  })

  test('differs by project name and by path', () => {
    const base = fileIdOf('web', 'a/b.test.ts')
    assert.notEqual(base, fileIdOf('api', 'a/b.test.ts'))
    assert.notEqual(base, fileIdOf('web', 'a/c.test.ts'))
  })

  test('does not confuse a project name and a path that join to the same text', () => {
    assert.notEqual(fileIdOf('ab', 'c'), fileIdOf('a', 'bc'))
  })

  test('is ten hex digits', () => {
    assert.match(fileIdOf('', 'x.test.ts'), /^[0-9a-f]{10}$/)
  })
})
