// Runs one `fixtures/expect/policies` test file through `@provino/core` with `expect` built the
// way the worker builds it, including the parts that make the async policies work (T7.8): the
// unawaited-assertion tracking `CorePolicy.unawaitedAsyncAssertion` turns on, and the end-of-test
// check on core's `onAfterTryTask`. The pattern is `expect-corpus/run-expect.ts`'s (the T7.5
// message check), which stays as it is; this one takes the two policy slices it runs under.
//
// Core listens for the process's uncaught exceptions and rejections, as the worker does
// (`captureProcessErrors`): an unawaited assertion that fails after its test has ended is charged
// by `errors.lateErrors`. `node:test` has handlers of its own for those, so this runs in a child
// process (`child.ts`).
import { pathToFileURL } from 'node:url'
import { createRuntime, currentTest } from '@provino/core'
import { jestMockPolicy } from '@provino/dialect-jest'
import { jestGlobals } from '@provino/dialect-jest/runtime'
import {
  createEndOfTest,
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import { createMockRegistry, type MockRegistry } from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import type { CorePolicy, ExpectPolicy, RuntimeEvent } from '@provino/types'
import { type ExpectTest, summarizeExpectRun } from '../expect-corpus/run-expect.ts'
import { installGlobals } from '../internal/globals.ts'
import { unusedJestHost } from '../internal/unused-jest-host.ts'

/** The slices a run is under: the Jest and Vitest dialects' own, or a flipped one. */
export interface PolicyRun {
  readonly core: CorePolicy
  readonly expect: ExpectPolicy
}

/** Distinguishes two imports of one file in a process: a module is evaluated once per URL. */
let imports = 0

/**
 * Runs `file` (absolute) under `run`. The file is imported under a query of its own, since a
 * process evaluates a URL once and the same fixture runs under both profiles; the frames a failure
 * prints lose the query again.
 */
export async function runPolicyFile(
  file: string,
  rootDir: string,
  run: PolicyRun,
): Promise<readonly ExpectTest[]> {
  const query = `policy-run-${imports++}`
  const behaviours = createBehaviourLoader()
  const source = createStateSource(currentTest, {
    nameSeparator: run.core.nameSeparator,
    expand: run.expect.expand,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  const events: RuntimeEvent[] = []
  let mocks: MockRegistry | undefined
  try {
    if (run.expect.matcherTable === null) throw new Error('the policy corpus needs a matcher table')
    const table = (await behaviours.load(run.expect.matcherTable))()
    const expect = createExpect({
      policy: run.expect,
      table,
      source,
      registry,
      unawaited: run.core.unawaitedAsyncAssertion,
    })
    const mockRegistry = createMockRegistry()
    mocks = mockRegistry
    const runtime = await createRuntime({
      policy: run.core,
      behaviours,
      sink: { emit: (event) => events.push(event) },
      importFile: (path) => import(`${pathToFileURL(path).href}?${query}`),
      rootDir,
      ci: true,
    })
    // Registered as the worker registers it (`worker/runtime/runner.ts`).
    const endOfTest = createEndOfTest({
      source,
      messages: table.messages,
      policy: run.expect,
      hasAssertionsWhenFailed: run.core.errors.hasAssertionsWhenFailed,
    })
    runtime.onAfterTryTask(({ test, attempt, repeat, failed, fail }) => {
      for (const error of endOfTest({ test, attempt, repeat, failed })) fail(error)
    })
    const restore = installGlobals({
      ...runtime.api,
      expect,
      jest: jestGlobals({
        ...unusedJestHost(runtime.api, mockRegistry, jestMockPolicy, 'the policy corpus'),
        expect,
      }).jest,
    })
    const stopProcessErrors = runtime.captureProcessErrors()
    try {
      source.startFile(file)
      try {
        await runtime.runFile(file)
        // The worker yields a macrotask here: Node reports a rejection a test left behind then.
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        stopProcessErrors()
        await runtime.dispose()
      }
    } finally {
      restore()
    }
  } finally {
    try {
      mocks?.dispose()
    } finally {
      slot.uninstall()
    }
  }
  const tests = summarizeExpectRun(events, (id, attempt) => source.stateOf(id, attempt))
  return tests.map((test) => ({
    ...test,
    failures: test.failures.map((failure) => ({
      ...failure,
      text: failure.text.replaceAll(`?${query}`, ''),
    })),
  }))
}
