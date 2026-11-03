// `createRuntime` and `runFile`: how a file is reported, what happens when collection fails or
// two files overlap, and the file's own teardowns.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createBehaviourLoader } from '@provino/policy'
import type { RuntimeEvent } from '@provino/types'
import { policyWith, reached, runScript } from './internal/test-support.ts'
import { createRuntime, type Runtime } from './runtime.ts'

describe('runFile', () => {
  test('reports the path relative to rootDir, with forward slashes', async () => {
    const events: RuntimeEvent[] = []
    const runtime = await createRuntime({
      policy: policyWith(),
      behaviours: createBehaviourLoader(),
      sink: { emit: (event) => events.push(event) },
      importFile: async () => {},
      rootDir: '/project',
    })
    await runtime.runFile('/project/src/deep/a.test.ts')
    const [start] = events
    assert.equal(start?.type === 'file-collect-start' && start.path, 'src/deep/a.test.ts')
  })

  test('a file whose collection throws reports its error, no tasks and a failed file', async () => {
    const run = await runScript(({ test }) => {
      test('registered before the throw', () => {})
      throw new Error('file blew up')
    })
    const collected = run.events.find((event) => event.type === 'file-collect-end')
    assert.equal(
      collected?.type === 'file-collect-end' && collected.errors[0]?.message,
      'file blew up',
    )
    assert.equal(run.tasks.length, 1)
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(
      run.events.map((event) => event.type),
      ['file-collect-start', 'file-collect-end', 'file-end'],
    )
  })

  test('a file with no tests passes', async () => {
    const run = await runScript(() => {})
    assert.equal(run.file.state, 'pass')
  })

  test('a file whose tests are all skipped is skipped', async () => {
    const run = await runScript(({ test }) => {
      test.skip('t', () => {})
    })
    assert.equal(run.file.state, 'skip')
  })

  test('a failing test fails the file, with no file-level errors of its own', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {
        throw new Error('boom')
      })
    })
    assert.equal(run.file.state, 'fail')
    assert.deepEqual(run.file.errors, [])
  })

  test('runs one file after another on one runtime, each with its own ids and tests', async () => {
    const events: RuntimeEvent[] = []
    const runtime = await createRuntime({
      policy: policyWith(),
      behaviours: createBehaviourLoader(),
      sink: { emit: (event) => events.push(event) },
      importFile: async () => {},
      rootDir: '/project',
    })
    await runtime.runFile('/project/a.test.ts')
    await runtime.runFile('/project/b.test.ts')
    const ids = events.flatMap((event) => (event.type === 'file-end' ? [event.fileId] : []))
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
  })

  test('a lines filter applies only to the file it is given for', async () => {
    const runtime = await createRuntime({
      policy: policyWith(),
      behaviours: createBehaviourLoader(),
      sink: { emit: () => {} },
      importFile: async () => {
        runtime.api.test('t', () => {})
      },
      rootDir: '/project',
    })
    // No test is on line 1, so the filter fails the file it is given for.
    const filtered = await runtime.runFile('/project/a.test.ts', { lines: [1] })
    const unfiltered = await runtime.runFile('/project/b.test.ts')
    assert.equal(filtered.errors[0]?.code, 'CORE_INVALID_ARGUMENT')
    assert.equal(unfiltered.state, 'pass')
  })

  test('a registration after the file has finished is reported against no file, without throwing', async () => {
    const run = await runScript(({ test }) => {
      test('t', () => {})
    })
    const before = run.events.length
    run.runtime.api.test('too late', () => {})
    const late = run.events.slice(before)
    assert.equal(late.length, 1)
    assert.equal(late[0]?.type === 'unhandled-error' && late[0].ownerId, null)
    assert.equal(
      late[0]?.type === 'unhandled-error' && late[0].error.code,
      'CORE_LATE_REGISTRATION',
    )
  })
})

describe('runFile while another file is active', () => {
  /** A runtime whose files each run one test that waits for `gate`. */
  async function gatedRuntime(gate: Promise<void>, started: () => void) {
    const events: RuntimeEvent[] = []
    const runtime = await createRuntime({
      policy: policyWith(),
      behaviours: createBehaviourLoader(),
      sink: { emit: (event) => events.push(event) },
      importFile: async () => {
        runtime.api.test('waits', async () => {
          started()
          await gate
        })
      },
      rootDir: '/project',
    })
    return { runtime, events }
  }

  test('a second file started while the first is still collecting rejects with CORE_BUSY', async () => {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const runtime = await createRuntime({
      policy: policyWith(),
      behaviours: createBehaviourLoader(),
      sink: { emit: () => {} },
      importFile: async () => {
        started.resolve()
        await gate.promise
      },
      rootDir: '/project',
    })
    const first = runtime.runFile('/project/a.test.ts')
    await started.promise
    await assert.rejects(runtime.runFile('/project/b.test.ts'), { code: 'CORE_BUSY' })
    gate.resolve()
    assert.equal((await first).state, 'pass')
  })

  test('a second file started while the first is running its tests rejects with CORE_BUSY', async () => {
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const { runtime, events } = await gatedRuntime(gate.promise, started.resolve)
    const first = runtime.runFile('/project/a.test.ts')
    await reached(started.promise, first)
    await assert.rejects(runtime.runFile('/project/b.test.ts'), { code: 'CORE_BUSY' })
    gate.resolve()
    assert.equal((await first).state, 'pass')
    assert.equal(events.filter((event) => event.type === 'file-collect-start').length, 1)
  })

  test('a test that starts another file fails with CORE_BUSY, and its own file runs on', async () => {
    const run = await runScript(({ test }, _step, runtime) => {
      test('nested', () => runtime.runFile('/project/other.test.ts'))
      test('after', () => {})
    })
    assert.equal(run.results.nested?.errors[0]?.code, 'CORE_BUSY')
    assert.equal(run.states.after, 'pass')
  })

  test('the runtime takes the next file once the first has ended', async () => {
    const gate = Promise.withResolvers<void>()
    const { runtime } = await gatedRuntime(gate.promise, () => {})
    gate.resolve()
    await runtime.runFile('/project/a.test.ts')
    assert.equal((await runtime.runFile('/project/b.test.ts')).state, 'pass')
  })
})

describe('file teardowns', () => {
  /** Adds a file teardown from a describe body or the file's top level. */
  const addFileTeardown = (runtime: Runtime, fn: () => unknown): void => {
    const suite = runtime.lazyHost.collecting()
    assert.ok(suite)
    suite.file.teardowns.push(fn)
  }

  test('run after a file whose collection threw', async () => {
    const run = await runScript((_api, step, runtime) => {
      addFileTeardown(runtime, () => step('file teardown'))
      throw new Error('collection failed')
    })
    assert.deepEqual(run.trace, ['file teardown'])
    assert.equal(run.file.state, 'fail')
  })

  test('run after a root aroundAll that threw before running the suite', async () => {
    const run = await runScript(({ test, aroundAll }, step, runtime) => {
      addFileTeardown(runtime, () => step('file teardown'))
      aroundAll(() => {
        throw new Error('no suite for you')
      })
      test('t', () => step('body'))
    })
    assert.deepEqual(run.trace, ['file teardown'])
  })

  test('run after the root aroundAll has finished, last added first', async () => {
    const run = await runScript(({ test, aroundAll }, step, runtime) => {
      addFileTeardown(runtime, () => step('first added'))
      addFileTeardown(runtime, () => step('second added'))
      aroundAll(async (runSuite) => {
        await runSuite()
        step('aroundAll teardown')
      })
      test('t', () => {})
    })
    assert.deepEqual(run.trace, ['aroundAll teardown', 'second added', 'first added'])
  })

  test('one that throws fails the file, and the rest still run', async () => {
    const run = await runScript(({ test }, step, runtime) => {
      addFileTeardown(runtime, () => step('ran'))
      addFileTeardown(runtime, () => {
        throw new Error('teardown failed')
      })
      test('t', () => {})
    })
    assert.deepEqual(run.trace, ['ran'])
    assert.deepEqual(
      run.file.errors.map((error) => error.message),
      ['teardown failed'],
    )
  })
})
