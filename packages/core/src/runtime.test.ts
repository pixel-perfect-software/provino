// `createRuntime` and `runFile`: how a file is reported, and what happens when collection fails or
// two files overlap.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createBehaviourLoader } from '@provino/policy'
import type { RuntimeEvent } from '@provino/types'
import { policyWith, runScript } from './internal/test-support.ts'
import { createRuntime } from './runtime.ts'

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

  test('a second file started while the first is still collecting fails with CORE_BUSY', async () => {
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
    const second = await runtime.runFile('/project/b.test.ts')
    gate.resolve()
    assert.equal(second.state, 'fail')
    assert.equal(second.errors[0]?.code, 'CORE_BUSY')
    assert.equal((await first).state, 'pass')
  })
})
