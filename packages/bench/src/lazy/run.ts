// Runs scripted test files through the real `@provino/core` runtime with `@provino/lazy` over its
// `LazyHost`, under one whole policy (the Jest dialect's, or the neutral one). The behaviours in
// `behaviours.ts` assert on what these runs record.
import { createRuntime, type Runtime, type RuntimeApi } from '@provino/core'
import { jestPolicy } from '@provino/dialect-jest'
import { createLazyRuntime, type LazyCore } from '@provino/lazy'
import { createBehaviourLoader, neutralPolicy, resolvePolicy } from '@provino/policy'
import type { Policy, RuntimeEvent, SerializedError, TaskResult, TestTask } from '@provino/types'

/** The policies the check runs every behaviour under. */
export const VARIANTS: readonly { readonly name: string; readonly policy: Policy }[] = [
  { name: 'jest', policy: resolvePolicy(jestPolicy) },
  { name: 'neutral', policy: neutralPolicy },
]

/** What a script gets: the runtime's API, the lazy root and a step trace. */
export interface Env {
  readonly api: RuntimeApi
  readonly runtime: Runtime
  readonly lazyRuntime: LazyCore
  readonly lazy: LazyCore['lazy']
  /** Names a step; `RunResult.trace` lists them in order. */
  step(name: string): void
}

/** One test file: collects with `env`. */
export type Script = (env: Env) => void | Promise<void>

/** What the files did. */
export interface RunResult {
  readonly runtime: Runtime
  readonly lazyRuntime: LazyCore
  readonly trace: readonly string[]
  readonly events: readonly RuntimeEvent[]
  /** A test's final state by its full name joined with ` > `, over every file. */
  readonly states: Readonly<Record<string, string>>
  readonly errors: Readonly<Record<string, readonly SerializedError[]>>
  readonly results: Readonly<Record<string, TaskResult>>
  /** The errors each file ended with, by file index. */
  readonly fileErrors: readonly (readonly SerializedError[])[]
}

/** Runs each script as one file, in order, in one runtime, then disposes the runtime. */
export async function runFiles(policy: Policy, scripts: readonly Script[]): Promise<RunResult> {
  const events: RuntimeEvent[] = []
  const trace: string[] = []
  const step = (name: string): void => {
    trace.push(name)
  }
  let env: Env | undefined
  const runtime: Runtime = await createRuntime({
    policy: policy.core,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async (path) => {
      const script = scripts[Number(/lazy-(\d+)\.test\.ts$/.exec(path)?.[1])]
      if (script === undefined || env === undefined) throw new Error(`no script for ${path}`)
      return script(env)
    },
    rootDir: '/bench',
    locations: false,
  })
  const lazyRuntime = createLazyRuntime({ host: runtime.lazyHost, policy: policy.lazy })
  env = { api: runtime.api, runtime, lazyRuntime, lazy: lazyRuntime.lazy, step }
  const fileErrors: SerializedError[][] = []
  const keepAlive = setInterval(() => {}, 60_000)
  try {
    for (let i = 0; i < scripts.length; i++) {
      const file = await runtime.runFile(`/bench/lazy-${i}.test.ts`)
      fileErrors.push([...file.errors])
    }
    await runtime.dispose()
  } finally {
    clearInterval(keepAlive)
  }
  const tests = new Map<string, TestTask>()
  for (const event of events) {
    if (event.type !== 'file-collect-end') continue
    for (const task of event.tasks) if (task.type === 'test') tests.set(task.id, task)
  }
  const states: Record<string, string> = {}
  const errors: Record<string, readonly SerializedError[]> = {}
  const results: Record<string, TaskResult> = {}
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const test = tests.get(event.id)
    if (test === undefined) continue
    const name = test.fullName.join(' > ')
    states[name] = event.result.state
    errors[name] = event.result.errors
    results[name] = event.result
  }
  return { runtime, lazyRuntime, trace, events, states, errors, results, fileErrors }
}

/** Runs one script as one file. */
export function runFile(policy: Policy, script: Script): Promise<RunResult> {
  return runFiles(policy, [script])
}
