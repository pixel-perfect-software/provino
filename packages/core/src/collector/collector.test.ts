// T5.3 acceptance: each `collect.*` policy value, the registration API and the task tree it builds,
// one value at a time against the neutral base. The scripts below are the "test files": they run
// through a real runtime (`runScript`), so a registration goes through the same path a file's does.
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CorePolicy } from '@provino/types'
import type { FileState } from '../internal/model.ts'
import {
  type CoreOverrides,
  eventsOf,
  locateMarker,
  policyWith,
  runScript,
  type Script,
  type ScriptRun,
  settle,
  suiteNamed,
  testNamed,
  testsOf,
  watch,
} from '../internal/test-support.ts'
import { createApi, type RuntimeApi } from './api.ts'
import { Collector } from './collector.ts'
import { type FinalizeOptions, finalize } from './finalize.ts'
import { registerFromHelper, registerHookFromHelper } from './fixtures/register-helper.ts'
import { newFileState } from './nodes.ts'

/** The error codes a file failed with. */
function fileCodes(run: ScriptRun): Array<string | undefined> {
  return run.file.errors.map((error) => error.code)
}

/**
 * A collector and its API with no runtime around them, so a test can drive files by hand and see
 * the tree and the late-registration reports.
 */
function bareCollector(overrides: CoreOverrides = {}, locations = false) {
  const policy = policyWith(overrides)
  const late: Array<{ readonly file: string | undefined; readonly code: string }> = []
  const collector = new Collector({
    policy,
    formatEachTitle: (name) => name,
    locations,
    onLateRegistration: (error, chargedTo) =>
      late.push({ file: chargedTo?.path, code: error.code }),
  })
  const api = createApi(collector)
  /** Collects `script` as the file at `path`, then closes it, as the runtime does. */
  const collectFile = async (
    path: string,
    script: (api: RuntimeApi) => unknown,
  ): Promise<FileState> => {
    const file = newFileState(path, basename(path), new AbortController().signal)
    await collector.collect(file, async () => script(api))
    collector.close(file)
    return file
  }
  return { policy, collector, api, late, collectFile }
}

/** Finalize options with no filters. */
function plainFinalize(policy: CorePolicy): FinalizeOptions {
  return {
    policy,
    projectName: '',
    ci: false,
    testNamePattern: undefined,
    testIds: undefined,
    lines: undefined,
  }
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

  test('await: a body that rejects while another is awaited is never an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const { collectFile } = bareCollector({ asyncDescribe: 'await' })
      const gate = Promise.withResolvers<void>()
      const collecting = collectFile('/project/a.test.ts', ({ describe }) => {
        describe('waits', async () => {
          await gate.promise
        })
        describe('fails', async () => {
          await Promise.resolve()
          throw new Error('body failed')
        })
      })
      // One event-loop turn (no timer): `fails` has rejected, and Node has looked for rejections
      // nothing handles.
      await new Promise<void>((resolve) => setImmediate(resolve))
      gate.resolve()
      await assert.rejects(collecting, /body failed/)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  test('await: a failed collection lets every async body settle, then throws the first error', async () => {
    const { collectFile } = bareCollector({ asyncDescribe: 'await' })
    const gate = Promise.withResolvers<void>()
    const collecting = collectFile('/project/a.test.ts', ({ describe }) => {
      describe('slow', async () => {
        await gate.promise
        throw new Error('body failed too')
      })
      throw new Error('top level failed')
    })
    const state = watch(collecting)
    await settle()
    assert.equal(state.settled, false, 'collection still waits for the slow body')
    gate.resolve()
    await assert.rejects(collecting, /top level failed/)
  })
})

describe('Collector.collecting', () => {
  test('is undefined in a describe-body continuation once its file is collected', async () => {
    const { collector, collectFile } = bareCollector()
    const gate = Promise.withResolvers<void>()
    let seen: Promise<unknown> | undefined
    await collectFile('/project/a.test.ts', ({ describe }) => {
      describe('d', () => {
        seen = gate.promise.then(() => collector.collecting())
      })
    })
    gate.resolve()
    assert.equal(await seen, undefined)
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

  test('a registration after the file has finished is reported, never thrown', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    assert.doesNotThrow(() => run.runtime.api.test('too late', () => {}))
    const [unhandled] = eventsOf(run.events, 'unhandled-error')
    assert.equal(unhandled?.origin, 'late-registration')
    assert.equal(unhandled?.error.code, 'CORE_LATE_REGISTRATION')
  })

  test('a late registration is charged to the file its describe belongs to, not the file collecting now', async () => {
    const { late, collectFile } = bareCollector()
    const gate = Promise.withResolvers<void>()
    let registered: Promise<void> | undefined
    await collectFile('/project/first.test.ts', ({ describe, test }) => {
      describe('d', () => {
        // A continuation of the describe body, as a timer started there would be.
        registered = gate.promise.then(() => test('late', () => {}))
      })
    })
    await collectFile('/project/second.test.ts', async () => {
      gate.resolve()
      await registered
    })
    assert.deepEqual(late, [{ file: '/project/first.test.ts', code: 'CORE_LATE_REGISTRATION' }])
  })

  test('a describe-body continuation that registers once no file is current is still charged to its file, and never throws', async () => {
    const { collector, late, collectFile } = bareCollector()
    const gate = Promise.withResolvers<void>()
    let registered: Promise<void> | undefined
    const file = await collectFile('/project/first.test.ts', ({ describe, test }) => {
      describe('d', () => {
        registered = gate.promise.then(() => test('late', () => {}))
      })
    })
    collector.release(file)
    gate.resolve()
    await assert.doesNotReject(async () => registered)
    assert.deepEqual(late, [{ file: '/project/first.test.ts', code: 'CORE_LATE_REGISTRATION' }])
  })

  test('a registration outside any file is reported with no file, never thrown', () => {
    const { api, late } = bareCollector()
    assert.doesNotThrow(() => api.test('outside', () => {}))
    assert.deepEqual(late, [{ file: undefined, code: 'CORE_LATE_REGISTRATION' }])
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

  test('todo leaves test.skip with no function skipped', async () => {
    const run = await runScript(
      ({ test }) => {
        test.skip('x')
      },
      { missingTestFn: 'todo' },
    )
    assert.equal(testNamed(run, 'x').mode, 'skip')
    assert.deepEqual(run.states, { x: 'skip' })
  })

  test('todo leaves test.only with no function focused, so it still narrows the file', async () => {
    const run = await runScript(
      ({ test }) => {
        test.only('focused')
        test('other', () => {})
      },
      { missingTestFn: 'todo' },
    )
    assert.equal(testNamed(run, 'focused').mode, 'only')
    assert.equal(run.results.other?.skipReason, 'only-filter')
  })

  test('todo leaves describe.skip and describe.only with no body as they were declared', async () => {
    const run = await runScript(
      ({ describe }) => {
        describe.skip('skipped')
        describe.only('focused')
      },
      { missingTestFn: 'todo' },
    )
    assert.equal(suiteNamed(run, 'skipped').mode, 'skip')
    assert.equal(suiteNamed(run, 'focused').mode, 'only')
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

  // The `retry` option is checked when a test or describe is registered (T5.10), so a wrong one is
  // an error of the file naming it, not a silent 0 or a "condition is not a function" at the first
  // failure.
  for (const [label, retry, message] of [
    ['a string', '2', /`retry` option's value must be a number or an object .*, got string/],
    ['null', null, /value must be .*got null/],
    ['an array', [2], /value must be .*got array/],
    ['a count that is a string', { count: '2' }, /`count` must be a number, got string/],
    ['a delay that is a string', { count: 1, delay: '50' }, /`delay` must be a number, got string/],
    [
      'a condition that is a string',
      { condition: 'x' },
      /`condition` must be a RegExp or a function, got string/,
    ],
    ['a condition that is an object', { condition: {} }, /`condition` must be .*got object/],
  ] as const) {
    test(`a test whose retry is ${label} fails the file with CORE_INVALID_ARGUMENT, at registration`, async () => {
      const run = await runScript(({ test }, step) => {
        test('x', { retry: retry as never }, () => step('ran'))
      })
      assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
      assert.match(run.file.errors[0]?.message ?? '', message)
      assert.deepEqual(run.trace, [])
    })
  }

  test('a describe whose retry is wrong fails the file with CORE_INVALID_ARGUMENT, at registration', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('d', { retry: { condition: 5 } as never }, () => {
        test('x', () => {})
      })
    })
    assert.deepEqual(fileCodes(run), ['CORE_INVALID_ARGUMENT'])
    assert.match(run.file.errors[0]?.message ?? '', /`condition` must be a RegExp or a function/)
  })

  test('a retry that is a number, an object or a condition of either kind is accepted', async () => {
    const run = await runScript(({ test }) => {
      test('number', { retry: 2 }, () => {})
      test('object', { retry: { count: 2, delay: 5, condition: /x/ } }, () => {})
      test('function', { retry: { count: 1, condition: () => true } }, () => {})
      test('empty object', { retry: {} }, () => {})
    })
    assert.deepEqual(run.file.errors, [])
    assert.deepEqual(
      testsOf(run.tasks).map((task) => task.retry),
      [2, 2, 1, 0],
    )
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

  test('dupIndex counts across same-named sibling describes, and apart from a same-named test', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('d', () => {
        test('same', () => {})
        describe('e', () => {
          test('same', () => {})
        })
      })
      test('d', () => {})
      describe('d', () => {
        test('same', () => {})
        describe('e', () => {
          test('same', () => {})
        })
      })
      test('d', () => {})
    })
    assert.deepEqual(
      testsOf(run.tasks).map((task) => [task.fullName.join(' > '), task.dupIndex]),
      [
        ['d > same', 0],
        ['d > e > same', 0],
        ['d', 0],
        ['d > same', 1],
        ['d > e > same', 1],
        ['d', 1],
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

  test('a describe inside a concurrent describe is concurrent too, unless it opts out', async () => {
    const run = await runScript(({ describe, test }) => {
      describe.concurrent('outer', () => {
        describe('inherits', () => {
          test('t', () => {})
        })
        describe('opted out', { concurrent: false }, () => {
          test('t', () => {})
        })
      })
    })
    assert.equal(suiteNamed(run, 'outer > inherits').concurrent, true)
    assert.equal(suiteNamed(run, 'outer > opted out').concurrent, false)
    assert.equal(testNamed(run, 'outer > opted out > t').concurrent, false)
  })

  test('a number third to describe is its timeout, which its tests inherit', async () => {
    const run = await runScript(({ describe, test }) => {
      describe('d', () => {
        test('t', () => {})
      }, 123)
      describe.each([[1]])(
        'row %i',
        () => {
          test('t', () => {})
        },
        45,
      )
    })
    assert.equal(testNamed(run, 'd > t').timeoutMs, 123)
    assert.equal(testNamed(run, 'row 1 > t').timeoutMs, 45)
  })
})

describe('timeouts.zero', () => {
  const zeroTests: Script = ({ test }) => {
    test('third arg', () => {}, 0)
    test('option', { timeout: 0 }, () => {})
  }

  test('default: a test timeout of 0 is the default timeout', async () => {
    const run = await runScript(zeroTests, { timeouts: { zero: 'default', test: 1234 } })
    assert.equal(testNamed(run, 'third arg').timeoutMs, 1234)
    assert.equal(testNamed(run, 'option').timeoutMs, 1234)
  })

  test('none: a test timeout of 0 stays 0, which is no deadline', async () => {
    const run = await runScript(zeroTests, { timeouts: { zero: 'none', test: 1234 } })
    assert.equal(testNamed(run, 'third arg').timeoutMs, 0)
    assert.equal(testNamed(run, 'option').timeoutMs, 0)
  })

  for (const [zero, expected] of [
    ['default', undefined],
    ['none', 0],
  ] as const) {
    test(`${zero}: a hook timeout of 0 becomes ${expected}, and other timeouts are kept`, async () => {
      const { collectFile } = bareCollector({ timeouts: { zero } })
      const file = await collectFile('/project/a.test.ts', ({ beforeEach, afterAll }) => {
        beforeEach(() => {}, 0)
        afterAll(() => {}, 25)
      })
      assert.equal(file.root.hooks.beforeEach[0]?.timeoutMs, expected)
      assert.equal(file.root.hooks.afterAll[0]?.timeoutMs, 25)
    })
  }
})

describe('suite options passed down', () => {
  test("a describe's only option makes everything inside it only, over a chained .skip", async () => {
    const run = await runScript(
      ({ describe, test }) => {
        describe('focused', { only: true }, () => {
          test.skip('chained skip', () => {})
          describe('nested', () => {
            test('inner', () => {})
          })
        })
        test('outside', () => {})
      },
      { focus: { scope: 'suite' } },
    )
    assert.equal(testNamed(run, 'focused > chained skip').mode, 'only')
    assert.equal(suiteNamed(run, 'focused > nested').mode, 'only')
    assert.equal(testNamed(run, 'focused > nested > inner').mode, 'only')
    assert.deepEqual(run.states, {
      'focused > chained skip': 'pass',
      'focused > nested > inner': 'pass',
      outside: 'skip',
    })
  })

  test("a describe's skip and todo options reach every descendant", async () => {
    const run = await runScript(({ describe, test }) => {
      describe('skipped', { skip: true }, () => {
        describe('nested', () => {
          test('t', () => {})
        })
      })
      describe('later', { todo: true }, () => {
        test('t', () => {})
      })
    })
    assert.equal(suiteNamed(run, 'skipped > nested').mode, 'skip')
    assert.equal(testNamed(run, 'skipped > nested > t').mode, 'skip')
    assert.equal(testNamed(run, 'later > t').mode, 'todo')
  })

  test("a registration's own option wins over the one it inherits", async () => {
    const run = await runScript(({ describe, test }) => {
      describe('skipped', { skip: true }, () => {
        test('not skipped', { skip: false }, () => {})
      })
    })
    assert.equal(testNamed(run, 'skipped > not skipped').mode, 'run')
  })

  test('a chained describe.only passes nothing down', async () => {
    const run = await runScript(({ describe, test }) => {
      describe.only('chained', () => {
        test('t', () => {})
      })
    })
    assert.equal(testNamed(run, 'chained > t').mode, 'run')
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

  test('each passes every row unspread when the table mixes arrays and other rows', async () => {
    const seen: unknown[][] = []
    const bodies: unknown[][] = []
    await runScript(({ describe, test }) => {
      test.each([[1, 2], 'x'])('row %#', (...args) => {
        seen.push(args)
      })
      describe.each([[1, 2], { a: 1 }])('suite %#', (...args) => {
        bodies.push(args)
      })
    })
    assert.deepEqual(seen, [[[1, 2]], ['x']])
    assert.deepEqual(bodies, [[[1, 2]], [{ a: 1 }]])
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
})

describe('collect.eachTableError', () => {
  /** A missing test function, past the API's types. */
  const NO_FN = undefined as never
  const failingTest = { collect: { eachTableError: 'failing-test' } } as const
  const lenient = { collect: { eachTableError: 'lenient' } } as const

  test('failing-test: a template whose values leave its last row short is one failing test under the raw title, and the rest of the file runs', async () => {
    const run = await runScript(({ test }) => {
      test.each`
        a    | b
        ${1} | ${2}
        ${3}
      `('adds $a and $b', () => {})
      test('other', () => {})
    }, failingTest)
    assert.deepEqual(run.states, { 'adds $a and $b': 'fail', other: 'pass' })
    assert.equal(run.results['adds $a and $b']?.errors[0]?.code, 'CORE_INVALID_EACH_TABLE')
    assert.deepEqual(run.file.errors, [])
  })

  for (const [what, register] of [
    ['an empty table', ({ test }: RuntimeApi) => test.each([])('row %#', () => {})],
    // The API's types require the function; the runtime still has to handle its absence.
    ['a table with no function', ({ test }: RuntimeApi) => test.each([[1]])('row %#', NO_FN)],
    [
      'a table that is not an array',
      ({ test }: RuntimeApi) => test.each('nope' as never)('row %#', () => {}),
    ],
    [
      'describe.each with an empty table',
      ({ describe }: RuntimeApi) => describe.each([])('row %#', () => {}),
    ],
  ] as const) {
    test(`failing-test: ${what} is one failing test under the raw title`, async () => {
      const run = await runScript((api) => {
        register(api)
        api.test('other', () => {})
      }, failingTest)
      assert.deepEqual(run.states, { 'row %#': 'fail', other: 'pass' })
      assert.equal(run.results['row %#']?.errors[0]?.code, 'CORE_INVALID_EACH_TABLE')
      assert.deepEqual(run.file.errors, [])
    })
  }

  test('failing-test: a modifier chained before each applies to the failing test', async () => {
    const run = await runScript(({ test }) => {
      test.skip.each([])('row %#', () => {})
    }, failingTest)
    assert.deepEqual(run.states, { 'row %#': 'skip' })
  })

  test('lenient: a template drops a last row its values leave short', async () => {
    const run = await runScript(({ test }) => {
      test.each`
        a    | b
        ${1} | ${2}
        ${3}
      `('adds $a and $b', () => {})
    }, lenient)
    assert.deepEqual(run.states, { 'adds 1 and 2': 'pass' })
    assert.deepEqual(run.file.errors, [])
  })

  test('lenient: an empty table registers nothing', async () => {
    const run = await runScript(({ describe, test }) => {
      test.each([])('row %#', () => {})
      describe.each([])('suite %#', () => {})
      test('other', () => {})
    }, lenient)
    assert.deepEqual(
      run.tasks.map((task) => task.name),
      ['script.test.ts', 'other'],
    )
  })

  test('lenient: a table with no function gives rows with no function, as missingTestFn says', async () => {
    const run = await runScript(
      ({ test }) => {
        test.each([[1], [2]])('row %i', NO_FN)
      },
      { ...lenient, missingTestFn: 'todo' },
    )
    assert.deepEqual(run.states, { 'row 1': 'todo', 'row 2': 'todo' })
  })

  test('lenient: a table that is neither an array nor a template fails the file with a TypeError', async () => {
    const run = await runScript(({ test }) => {
      test.each('nope' as never)('x', () => {})
    }, lenient)
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

describe('locationFrame', () => {
  const file = import.meta.filename
  const helperFile = fileURLToPath(new URL('./fixtures/register-helper.ts', import.meta.url))

  /** The location of the one test a helper module registers. */
  const helperTestLocation = async (locationFrame: 'caller' | 'test-file') => {
    const { policy, collectFile } = bareCollector({ locationFrame }, true)
    const collected = await collectFile(file, (api) => {
      // @marker:helper-call
      registerFromHelper(api, 'shared')
    })
    const [, task] = finalize(collected, plainFinalize(policy))
    return task?.location
  }

  test('test-file: a test a helper registers is located where the test file calls the helper', async () => {
    assert.deepEqual(
      await helperTestLocation('test-file'),
      locateMarker(file, '// @marker:helper-call', 'registerFromHelper('),
    )
  })

  test('caller: the same test is located in the helper', async () => {
    assert.equal((await helperTestLocation('caller'))?.file, helperFile)
  })

  /** The location of a hook a helper module registers. */
  const helperHookLocation = async (locationFrame: 'caller' | 'test-file') => {
    const { policy, collectFile } = bareCollector({ locationFrame }, true)
    const collected = await collectFile(file, (api) => {
      // @marker:hook-helper-call
      registerHookFromHelper(api)
      api.test('t', () => {})
    })
    finalize(collected, plainFinalize(policy))
    return collected.root.hooks.beforeEach[0]?.location
  }

  test('hooks follow locationFrame too: test-file points at the helper call in the test file', async () => {
    assert.deepEqual(
      await helperHookLocation('test-file'),
      locateMarker(file, '// @marker:hook-helper-call', 'registerHookFromHelper('),
    )
  })

  test('hooks follow locationFrame too: caller points into the helper', async () => {
    assert.equal((await helperHookLocation('caller'))?.file, helperFile)
  })
})
