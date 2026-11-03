// T5.3 acceptance: each `collect.*` policy value, the registration API and the task tree it builds,
// one value at a time against the neutral base. The scripts below are the "test files": they run
// through a real runtime (`runScript`), so a registration goes through the same path a file's does.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  eventsOf,
  locateMarker,
  runScript,
  type Script,
  type ScriptRun,
  suiteNamed,
  testNamed,
  testsOf,
} from '../internal/test-support.ts'
import type { RuntimeApi } from './api.ts'

/** The error codes a file failed with. */
function fileCodes(run: ScriptRun): Array<string | undefined> {
  return run.file.errors.map((error) => error.code)
}

describe('collect.describeBody', () => {
  const script: Script = ({ describe, test }, step) => {
    step('top: before')
    describe('outer', () => {
      step('outer body')
      describe('inner', () => {
        step('inner body')
        test('t', () => {})
      })
      step('outer body end')
    })
    step('top: after')
  }

  test('immediate runs a body where describe is called, nested bodies in line', async () => {
    const run = await runScript(script, { collect: { describeBody: 'immediate' } })
    assert.deepEqual(run.trace, [
      'top: before',
      'outer body',
      'inner body',
      'outer body end',
      'top: after',
    ])
  })

  test('deferred runs bodies after the file has loaded, a parent body before its children', async () => {
    const run = await runScript(script, { collect: { describeBody: 'deferred' } })
    assert.deepEqual(run.trace, [
      'top: before',
      'top: after',
      'outer body',
      'outer body end',
      'inner body',
    ])
  })

  test('deferred bodies still register their tests', async () => {
    const run = await runScript(script, { collect: { describeBody: 'deferred' } })
    assert.deepEqual(run.states, { 'outer > inner > t': 'pass' })
  })

  test('deferred runs sibling bodies in declaration order, each subtree before the next', async () => {
    const run = await runScript(
      ({ describe, test }, step) => {
        describe('a', () => {
          step('a')
          describe('a1', () => step('a1'))
        })
        describe('b', () => {
          step('b')
          test('t', () => {})
        })
      },
      { collect: { describeBody: 'deferred' } },
    )
    assert.deepEqual(run.trace, ['a', 'a1', 'b'])
  })
})

describe('asyncDescribe', () => {
  test('throw fails the file with CORE_ASYNC_DESCRIBE and collects no tasks', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        test('registered before the async describe', () => {})
        describe('d', async () => {
          test('registered inside it', () => {})
        })
      },
      { asyncDescribe: 'throw' },
    )
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_ASYNC_DESCRIBE'])
    assert.deepEqual(testsOf(run.tasks), [])
    assert.deepEqual(eventsOf(run.events, 'test-end'), [])
  })

  test('await collects a test registered after an await', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('d', async () => {
          await Promise.resolve()
          test('after the await', () => {})
        })
      },
      { asyncDescribe: 'await' },
    )
    assert.equal(run.file.state, 'pass')
    assert.deepEqual(run.states, { 'd > after the await': 'pass' })
  })

  test('await collects the same tests when bodies are deferred', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('d', async () => {
          await Promise.resolve()
          test('after the await', () => {})
        })
      },
      { asyncDescribe: 'await', collect: { describeBody: 'deferred' } },
    )
    assert.deepEqual(run.states, { 'd > after the await': 'pass' })
  })

  test('await puts a describe registered after an await under its parent', async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('outer', async () => {
          await Promise.resolve()
          describe('inner', () => {
            test('t', () => {})
          })
        })
      },
      { asyncDescribe: 'await' },
    )
    assert.deepEqual(run.states, { 'outer > inner > t': 'pass' })
  })

  test('await keeps interleaved async bodies apart: each registration lands in its own describe', async () => {
    const gate = Promise.withResolvers<void>()
    const run = await runScript(
      ({ describe, test }) => {
        describe('a', async () => {
          await gate.promise
          test('a1', () => {})
        })
        describe('b', async () => {
          test('b-sync', () => {})
          await Promise.resolve()
          test('b1', () => {})
        })
        // Both bodies are suspended now; `a` resumes after `b` has registered.
        gate.resolve()
      },
      { asyncDescribe: 'await' },
    )
    assert.deepEqual(
      testsOf(run.tasks).map((task) => task.fullName.join(' > ')),
      ['a > a1', 'b > b-sync', 'b > b1'],
    )
  })
})

describe('collect.describeReturnValue', () => {
  const script: Script = ({ describe, test }) => {
    describe('d', () => {
      test('t', () => {})
      return 1
    })
  }

  test('error fails the file with CORE_DESCRIBE_RETURN_VALUE', async () => {
    const run = await runScript(script, { collect: { describeReturnValue: 'error' } })
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_DESCRIBE_RETURN_VALUE'])
  })

  test('ignore drops the value and collects the body as usual', async () => {
    const run = await runScript(script, { collect: { describeReturnValue: 'ignore' } })
    assert.equal(run.file.state, 'pass')
    assert.deepEqual(run.states, { 'd > t': 'pass' })
  })
})

describe('collect.lateRegistration', () => {
  const script: Script = ({ test, beforeAll }, step) => {
    beforeAll(() => {
      test('late', () => step('late test ran'))
    })
    test('early', () => step('early test ran'))
  }

  test('fail-file reports the registration against the file and fails it', async () => {
    const run = await runScript(script, { collect: { lateRegistration: 'fail-file' } })
    const [unhandled, ...rest] = eventsOf(run.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    assert.equal(unhandled?.origin, 'late-registration')
    assert.equal(unhandled?.ownerId, run.tasks[0]?.id)
    assert.equal(unhandled?.error.code, 'CORE_LATE_REGISTRATION')
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_LATE_REGISTRATION'])
  })

  test('warn-drop reports the registration against the run and leaves the file passing', async () => {
    const run = await runScript(script, { collect: { lateRegistration: 'warn-drop' } })
    const [unhandled, ...rest] = eventsOf(run.events, 'unhandled-error')
    assert.equal(rest.length, 0)
    assert.equal(unhandled?.origin, 'late-registration')
    assert.equal(unhandled?.ownerId, null)
    assert.equal(run.file.state, 'pass')
    assert.deepEqual(run.file.errors, [])
  })

  for (const lateRegistration of ['fail-file', 'warn-drop'] as const) {
    test(`${lateRegistration} never runs the late test`, async () => {
      const run = await runScript(script, { collect: { lateRegistration } })
      assert.deepEqual(run.trace, ['early test ran'])
      assert.deepEqual(run.states, { early: 'pass' })
    })
  }

  test('a describe and a hook registered late are dropped too, each reported once', async () => {
    const run = await runScript(
      ({ describe, test, beforeAll, beforeEach }, step) => {
        beforeAll(() => {
          describe('late suite', () => step('late body'))
          beforeEach(() => step('late hook'))
        })
        test('early', () => {})
      },
      { collect: { lateRegistration: 'warn-drop' } },
    )
    assert.deepEqual(run.trace, [])
    assert.equal(eventsOf(run.events, 'unhandled-error').length, 2)
  })

  test('a registration after the file has finished throws CORE_LATE_REGISTRATION', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    assert.throws(() => run.runtime.api.test('too late', () => {}), {
      code: 'CORE_LATE_REGISTRATION',
    })
  })
})

describe('collect.nestedInTest', () => {
  const registrations: ReadonlyArray<readonly [string, (api: RuntimeApi) => void]> = [
    ['test', ({ test }) => test('inner', () => {})],
    ['describe', ({ describe }) => describe('inner', () => {})],
    ['beforeEach', ({ beforeEach }) => beforeEach(() => {})],
  ]

  for (const [what, register] of registrations) {
    test(`fail-test: a ${what} inside a test lets the body finish, then fails the test`, async () => {
      const run = await runScript(
        (api, step) => {
          api.test('outer', () => {
            step('before')
            register(api)
            step('after')
          })
        },
        { collect: { nestedInTest: 'fail-test' } },
      )
      assert.deepEqual(run.trace, ['before', 'after'])
      assert.equal(run.states.outer, 'fail')
      assert.equal(run.results.outer?.errors[0]?.code, 'CORE_NESTED_REGISTRATION')
    })

    test(`throw: a ${what} inside a test stops the body and fails the test`, async () => {
      const run = await runScript(
        (api, step) => {
          api.test('outer', () => {
            step('before')
            register(api)
            step('after')
          })
        },
        { collect: { nestedInTest: 'throw' } },
      )
      assert.deepEqual(run.trace, ['before'])
      assert.equal(run.states.outer, 'fail')
      assert.equal(run.results.outer?.errors[0]?.code, 'CORE_NESTED_REGISTRATION')
    })
  }

  test('the nested test is never registered', async () => {
    const run = await runScript(
      ({ test }) => {
        test('outer', () => {
          test('inner', () => {})
        })
      },
      { collect: { nestedInTest: 'fail-test' } },
    )
    assert.deepEqual(Object.keys(run.states), ['outer'])
  })
})

describe('collect.todoWithFn', () => {
  test('throw fails the file with CORE_TODO_WITH_FN', async () => {
    const run = await runScript(
      ({ test }) => {
        test.todo('later', () => {})
      },
      { collect: { todoWithFn: 'throw' } },
    )
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(fileCodes(run), ['CORE_TODO_WITH_FN'])
    assert.deepEqual(testsOf(run.tasks), [])
  })

  test('throw also covers the todo option', async () => {
    const run = await runScript(
      ({ test }) => {
        test('later', { todo: true }, () => {})
      },
      { collect: { todoWithFn: 'throw' } },
    )
    assert.deepEqual(fileCodes(run), ['CORE_TODO_WITH_FN'])
  })

  test('throw allows a todo with no function', async () => {
    const run = await runScript(
      ({ test }) => {
        test.todo('later')
      },
      { collect: { todoWithFn: 'throw' } },
    )
    assert.deepEqual(run.file.errors, [])
    assert.deepEqual(run.states, { later: 'todo' })
  })

  test('todo keeps the todo and never runs its function', async () => {
    const run = await runScript(
      ({ test }, step) => {
        test.todo('later', () => step('ran'))
      },
      { collect: { todoWithFn: 'todo' } },
    )
    assert.deepEqual(run.states, { later: 'todo' })
    assert.deepEqual(run.trace, [])
  })
})

describe('missingTestFn', () => {
  test('throw fails the file for a test with no function', async () => {
    const run = await runScript(
      ({ test }) => {
        test('x')
      },
      { missingTestFn: 'throw' },
    )
    assert.deepEqual(fileCodes(run), ['CORE_MISSING_TEST_FN'])
    assert.deepEqual(testsOf(run.tasks), [])
  })

  test('throw fails the file for a describe with no body', async () => {
    const run = await runScript(
      ({ describe }) => {
        describe('d')
      },
      { missingTestFn: 'throw' },
    )
    assert.deepEqual(fileCodes(run), ['CORE_MISSING_TEST_FN'])
  })

  test('throw lets test.todo have no function', async () => {
    const run = await runScript(
      ({ test }) => {
        test.todo('later')
      },
      { missingTestFn: 'throw' },
    )
    assert.deepEqual(run.file.errors, [])
    assert.deepEqual(run.states, { later: 'todo' })
  })

  test('todo turns a test with no function into a todo', async () => {
    const run = await runScript(
      ({ test }) => {
        test('x')
      },
      { missingTestFn: 'todo' },
    )
    assert.deepEqual(run.file.errors, [])
    assert.deepEqual(run.states, { x: 'todo' })
  })

  test('todo turns a describe with no body into a todo suite', async () => {
    const run = await runScript(
      ({ describe }) => {
        describe('d')
      },
      { missingTestFn: 'todo' },
    )
    assert.deepEqual(run.file.errors, [])
    assert.equal(suiteNamed(run, 'd').mode, 'todo')
  })
})

describe('registration arguments', () => {
  test('options in the third position fail a test with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test }) => {
      test('x', () => {}, { timeout: 5 } as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('options in both the second and third position fail with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test }) => {
      test('x', {}, {} as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('options in the third position fail a describe with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ describe }) => {
      describe('d', (() => {}) as never, {} as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('a test function that is not a function fails with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ test }) => {
      test('x', 'nope' as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('a describe body that is not a function fails with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ describe }) => {
      describe('d', 5 as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('a hook that is not a function fails with CORE_INVALID_ARGUMENT', async () => {
    const run = await runScript(({ beforeEach }) => {
      beforeEach('nope' as never)
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
  })

  test('describe.shuffle fails with CORE_NOT_IMPLEMENTED', async () => {
    const run = await runScript(({ describe }) => {
      describe('d', { shuffle: true }, () => {})
    })
    assert.deepEqual(fileCodes(run), ['CORE_NOT_IMPLEMENTED'])
  })

  test('a class or function used as a name gives its own name', async () => {
    const run = await runScript(({ describe, test }) => {
      describe(class Widget {}, () => {
        test(
          function renders() {},
          () => {},
        )
      })
    })
    assert.deepEqual(Object.keys(run.states), ['Widget > renders'])
  })
})

describe('task ids and names', () => {
  const script: Script = ({ describe, test }) => {
    test('top', () => {})
    describe('a', () => {
      test('one', () => {})
      describe('b', () => {
        test('two', () => {})
      })
    })
  }

  test('the same file gets the same ids on every run', async () => {
    const first = await runScript(script)
    const second = await runScript(script)
    assert.deepEqual(
      first.tasks.map((task) => task.id),
      second.tasks.map((task) => task.id),
    )
  })

  test('a child id is its parent id and its index among all siblings', async () => {
    const run = await runScript(script)
    const [file] = run.tasks
    assert.ok(file)
    assert.equal(testNamed(run, 'top').id, `${file.id}_0`)
    assert.equal(suiteNamed(run, 'a').id, `${file.id}_1`)
    assert.equal(testNamed(run, 'a > b > two').id, `${suiteNamed(run, 'a > b').id}_0`)
  })

  test('the project name is part of the file id', async () => {
    const plain = await runScript(script)
    const named = await runScript(script, {}, { projectName: 'web' })
    assert.notEqual(plain.tasks[0]?.id, named.tasks[0]?.id)
  })

  test('a test carries its full name as the list of names from the file down', async () => {
    const run = await runScript(script)
    assert.deepEqual(testNamed(run, 'a > b > two').fullName, ['a', 'b', 'two'])
  })

  test('the file task is named for its path relative to the root', async () => {
    const run = await runScript(script)
    const [file] = run.tasks
    assert.equal(file?.type, 'file')
    assert.equal(file?.name, 'script.test.ts')
  })

  test('dupIndex counts tests with the same full name, from zero', async () => {
    const run = await runScript(({ describe, test }) => {
      test('same', () => {})
      test('same', () => {})
      describe('d', () => {
        test('same', () => {})
      })
      test('same', () => {})
    })
    assert.deepEqual(
      testsOf(run.tasks).map((task) => [task.fullName.join(' > '), task.dupIndex]),
      [
        ['same', 0],
        ['same', 1],
        ['d > same', 0],
        ['same', 2],
      ],
    )
  })
})

describe('test options', () => {
  test('timeouts.test is the default timeout', async () => {
    const run = await runScript(
      ({ test }) => {
        test('t', () => {})
      },
      { timeouts: { test: 1234 } },
    )
    assert.equal(testNamed(run, 't').timeoutMs, 1234)
  })

  test('the third argument, the options object and the describe options each set the timeout', async () => {
    const run = await runScript(({ describe, test }) => {
      test('plain', () => {})
      test('third arg', () => {}, 10)
      test('options', { timeout: 20 }, () => {})
      describe('inherit', { timeout: 30 }, () => {
        test('inherited', () => {})
        test('third arg wins', () => {}, 11)
        test('options win', { timeout: 21 }, () => {})
        describe('nested', () => {
          test('inherited twice', () => {})
        })
        describe('nested override', { timeout: 40 }, () => {
          test('overridden', () => {})
        })
      })
    })
    const timeouts = Object.fromEntries(
      testsOf(run.tasks).map((task) => [task.fullName.join(' > '), task.timeoutMs]),
    )
    assert.deepEqual(timeouts, {
      plain: 5000,
      'third arg': 10,
      options: 20,
      'inherit > inherited': 30,
      'inherit > third arg wins': 11,
      'inherit > options win': 21,
      'inherit > nested > inherited twice': 30,
      'inherit > nested override > overridden': 40,
    })
  })

  test('retry and repeats come from the options object or the describe, and default to 0', async () => {
    const run = await runScript(({ describe, test }) => {
      test('plain', () => {})
      test('own', { retry: 2, repeats: 3 }, () => {})
      describe('d', { retry: 1, repeats: 4 }, () => {
        test('inherited', () => {})
        test('own wins', { retry: 5 }, () => {})
      })
    })
    const counts = Object.fromEntries(
      testsOf(run.tasks).map((task) => [task.fullName.join(' > '), [task.retry, task.repeats]]),
    )
    assert.deepEqual(counts, {
      plain: [0, 0],
      own: [2, 3],
      'd > inherited': [1, 4],
      'd > own wins': [5, 4],
    })
  })

  test('tags merge from the describes down without repeats, and meta merges with the nearest winning', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('outer', { tags: 'a', meta: { x: 1, y: 1 } }, () => {
        describe('inner', { tags: ['b', 'a'], meta: { y: 2 } }, () => {
          test('t', { tags: 'c', meta: { z: 3 } }, () => {})
        })
      })
    })
    const task = testNamed(run, 'outer > inner > t')
    assert.deepEqual(task.tags, ['a', 'b', 'c'])
    assert.deepEqual(task.meta, { x: 1, y: 2, z: 3 })
    assert.deepEqual(suiteNamed(run, 'outer > inner').tags, ['a', 'b'])
  })

  test('a test is not concurrent unless it, or its describe, says so', async () => {
    const run = await runScript(({ describe, test }) => {
      test('plain', () => {})
      test.concurrent('chained', () => {})
      test('option', { concurrent: true }, () => {})
      describe('inherits', { concurrent: true }, () => {
        test('inherited', () => {})
        test('opted out', { concurrent: false }, () => {})
      })
    })
    const flags = Object.fromEntries(
      testsOf(run.tasks).map((task) => [task.fullName.join(' > '), task.concurrent]),
    )
    assert.deepEqual(flags, {
      plain: false,
      chained: true,
      option: true,
      'inherits > inherited': true,
      'inherits > opted out': false,
    })
  })

  test('describe.concurrent makes the tests inside it concurrent, as the options form does', async () => {
    const run = await runScript(({ describe, test }) => {
      describe.concurrent('chained', () => {
        test('t', () => {})
      })
      describe('option', { concurrent: true }, () => {
        test('t', () => {})
      })
    })
    assert.equal(testNamed(run, 'chained > t').concurrent, true)
    assert.equal(testNamed(run, 'option > t').concurrent, true)
    assert.equal(suiteNamed(run, 'chained').concurrent, true)
  })
})

describe('test modifiers', () => {
  test('skipIf(true) skips with the reason "condition", and skipIf(false) runs the test', async () => {
    const run = await runScript(({ test }, step) => {
      test.skipIf(true)('skipped', () => step('skipped'))
      test.skipIf(false)('runs', () => step('runs'))
    })
    assert.deepEqual(run.states, { skipped: 'skip', runs: 'pass' })
    assert.equal(run.results.skipped?.skipReason, 'condition')
    assert.deepEqual(run.trace, ['runs'])
  })

  test('runIf(false) skips with the reason "condition", and runIf(true) runs the test', async () => {
    const run = await runScript(({ test }, step) => {
      test.runIf(false)('skipped', () => step('skipped'))
      test.runIf(true)('runs', () => step('runs'))
    })
    assert.deepEqual(run.states, { skipped: 'skip', runs: 'pass' })
    assert.equal(run.results.skipped?.skipReason, 'condition')
    assert.deepEqual(run.trace, ['runs'])
  })

  test('a plain skip has the reason "modifier"', async () => {
    const run = await runScript(({ test }) => {
      test.skip('skipped', () => {})
    })
    assert.equal(run.results.skipped?.skipReason, 'modifier')
  })

  test('fails and failing pass a test whose body throws', async () => {
    const run = await runScript(({ test }) => {
      test.fails('fails', () => {
        throw new Error('boom')
      })
      test.failing('failing', () => {
        throw new Error('boom')
      })
      test('option', { fails: true }, () => {
        throw new Error('boom')
      })
    })
    assert.deepEqual(run.states, { fails: 'pass', failing: 'pass', option: 'pass' })
    assert.equal(testNamed(run, 'fails').expectFail, true)
    assert.equal(testNamed(run, 'failing').expectFail, true)
  })

  test('fails fails a test whose body passes, with CORE_EXPECTED_FAILURE', async () => {
    const run = await runScript(({ test }) => {
      test.fails('passes anyway', () => {})
    })
    assert.equal(run.states['passes anyway'], 'fail')
    assert.equal(run.results['passes anyway']?.errors[0]?.code, 'CORE_EXPECTED_FAILURE')
  })

  test('a modifier chained before each applies to every row', async () => {
    const run = await runScript(({ test }, step) => {
      test.skip.each([[1], [2]])('row %i', () => step('ran'))
    })
    assert.deepEqual(run.states, { 'row 1': 'skip', 'row 2': 'skip' })
    assert.deepEqual(run.trace, [])
  })
})

describe('.each and .for', () => {
  test('each spreads an array row into arguments and titles it with the neutral formatter', async () => {
    const seen: unknown[][] = []
    const run = await runScript(({ test }) => {
      test.each([
        [1, 2, 3],
        [4, 5, 9],
      ])('adds %i + %i = %i', (...args) => {
        seen.push(args)
      })
    })
    assert.deepEqual(Object.keys(run.states), ['adds 1 + 2 = 3', 'adds 4 + 5 = 9'])
    assert.deepEqual(seen, [
      [1, 2, 3],
      [4, 5, 9],
    ])
  })

  test('each passes an object row as one argument, and no context', async () => {
    const seen: unknown[][] = []
    await runScript(({ test }) => {
      test.each([{ a: 1, b: 2 }])('$a and $b', (...args) => {
        seen.push(args)
      })
    })
    assert.deepEqual(seen, [[{ a: 1, b: 2 }]])
  })

  test('each passes a primitive row as one argument', async () => {
    const seen: unknown[][] = []
    const run = await runScript(({ test }) => {
      test.each([10, 20])('n = %d', (...args) => {
        seen.push(args)
      })
    })
    assert.deepEqual(Object.keys(run.states), ['n = 10', 'n = 20'])
    assert.deepEqual(seen, [[10], [20]])
  })

  test('a tagged template table gives one object row per line, keyed by the heading', async () => {
    const seen: unknown[][] = []
    const run = await runScript(({ test }) => {
      test.each`
        a    | b    | expected
        ${1} | ${1} | ${2}
        ${2} | ${1} | ${3}
      `('$a + $b = $expected', (...args) => {
        seen.push(args)
      })
    })
    assert.deepEqual(Object.keys(run.states), ['1 + 1 = 2', '2 + 1 = 3'])
    assert.deepEqual(seen, [[{ a: 1, b: 1, expected: 2 }], [{ a: 2, b: 1, expected: 3 }]])
  })

  test('%# and %$ title a row by its zero-based and one-based index', async () => {
    const run = await runScript(({ test }) => {
      test.each([['x'], ['y']])('row %# / %$', () => {})
    })
    assert.deepEqual(Object.keys(run.states), ['row 0 / 1', 'row 1 / 2'])
  })

  test('each marks its tests as each rows', async () => {
    const run = await runScript(({ test }) => {
      test('plain', () => {})
      test.each([[1]])('row %i', () => {})
    })
    assert.equal(testNamed(run, 'plain').each, false)
    assert.equal(testNamed(run, 'row 1').each, true)
  })

  test('for passes the row unspread, then the context', async () => {
    const seen: unknown[][] = []
    const run = await runScript(({ test }) => {
      test.for([[1, 2]])('pair %i %i', (...args) => {
        seen.push(args)
      })
    })
    assert.deepEqual(Object.keys(run.states), ['pair 1 2'])
    const [row, context] = seen[0] ?? []
    assert.deepEqual(row, [1, 2])
    assert.equal((context as { task: { name: string } }).task.name, 'pair 1 2')
  })

  test('describe.each runs one body per row, with the row as arguments, and names each suite', async () => {
    const bodies: unknown[][] = []
    const run = await runScript(({ describe, test }) => {
      describe.each([[1], [2]])('suite %i', (...args) => {
        bodies.push(args)
        test('t', () => {})
      })
    })
    assert.deepEqual(Object.keys(run.states), ['suite 1 > t', 'suite 2 > t'])
    assert.deepEqual(bodies, [[1], [2]])
    assert.equal(suiteNamed(run, 'suite 1').each, true)
  })

  test('describe.for passes the row unspread to the body', async () => {
    const bodies: unknown[][] = []
    await runScript(({ describe }) => {
      describe.for([[1, 2]])('suite', (...args) => {
        bodies.push(args)
      })
    })
    assert.deepEqual(bodies, [[[1, 2]]])
  })

  test('a table that is neither an array nor a template fails the file with a TypeError', async () => {
    const run = await runScript(({ test }) => {
      test.each('nope' as never)('x', () => {})
    })
    assert.equal(run.file.state, 'fail')
    assert.equal(run.file.errors[0]?.name, 'TypeError')
  })
})

describe('locations', () => {
  const file = import.meta.filename

  test('locations: true gives a test, a describe and a hook the line and column of their call', async () => {
    const run = await runScript(
      ({ describe, test, beforeEach }) => {
        // @marker:describe
        describe('suite', () => {})
        // @marker:hook
        beforeEach(() => {})
        // @marker:test
        test('t', () => {})
      },
      {},
      { locations: true },
    )
    assert.deepEqual(testNamed(run, 't').location, locateMarker(file, '// @marker:test', 'test('))
    assert.deepEqual(
      suiteNamed(run, 'suite').location,
      locateMarker(file, '// @marker:describe', 'describe('),
    )
    const [hook] = eventsOf(run.events, 'hook-start')
    assert.deepEqual(hook?.location, locateMarker(file, '// @marker:hook', 'beforeEach('))
  })

  test('the location of a chained call is where the chain was called', async () => {
    const run = await runScript(
      ({ test }) => {
        // @marker:chained
        test.only('t', () => {})
      },
      {},
      { locations: true },
    )
    const location = testNamed(run, 't').location
    assert.equal(location?.file, file)
    assert.equal(location?.line, locateMarker(file, '// @marker:chained', 'test.only(').line)
  })

  test('locations: false leaves every location null', async () => {
    const run = await runScript(
      ({ describe, test, beforeEach }) => {
        describe('d', () => {
          beforeEach(() => {})
          test('t', () => {})
        })
      },
      {},
      { locations: false },
    )
    assert.deepEqual(
      run.tasks.map((task) => task.location),
      [null, null, null],
    )
    assert.equal(eventsOf(run.events, 'hook-start')[0]?.location, null)
  })
})
