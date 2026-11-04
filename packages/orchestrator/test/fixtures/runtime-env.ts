// A test environment that records its calls. Like the real node environment it runs in the
// worker's own realm and, at teardown, deletes the globals added since `setup`. It writes to
// `globalThis.__trace` when a test has set one (inline workers share the test's process), keeps the
// `signal` each `setup` received in `globalThis.__signals` when a test has set that, and its
// options steer failures: `failSetup` and `failTeardown`. `leak: 'a,b'` makes `teardown` report
// those keys as globals it could not remove (D22), without actually leaving anything behind.
import type { Environment } from '@provino/types'

type Traced = typeof globalThis & { __trace?: string[]; __signals?: AbortSignal[] }

/** Adds `step` to the test's trace, if there is one. */
export function trace(step: string): void {
  ;(globalThis as Traced).__trace?.push(step)
}

/** The matcher names the global slot holds right now. */
function slotMatchers(): string {
  const slot = Reflect.get(globalThis, Symbol.for('$$jest-matchers-object')) as
    | { matchers: object }
    | undefined
  return Object.keys(slot?.matchers ?? {}).join('+')
}

export const recordingEnvironment: Environment<
  'recording',
  { readonly [key: string]: string | number | boolean }
> = {
  name: 'recording',
  realms: ['worker'],
  prepare(options) {
    trace(`env:prepare ${JSON.stringify(options)}`)
    return { prepared: true }
  },
  setup(context, prepared) {
    trace(
      `env:setup ${context.scope} ${context.testPath.split('/').at(-1)} ${JSON.stringify(prepared)}`,
    )
    ;(globalThis as Traced).__signals?.push(context.signal)
    if (context.options.failSetup === true) throw new Error('setup failed')
    const before = new Set(Reflect.ownKeys(globalThis))
    return {
      global: globalThis,
      teardown() {
        trace(`env:teardown matchers=${slotMatchers()}`)
        for (const key of Reflect.ownKeys(globalThis)) {
          if (!before.has(key)) Reflect.deleteProperty(globalThis, key)
        }
        if (context.options.failTeardown === true) throw new Error('teardown failed')
        // D22: like the node environment, report what it could not restore instead of throwing.
        const leak = context.options.leak
        return typeof leak === 'string' ? { leakedGlobals: leak.split(',') } : undefined
      },
    }
  },
}

/** Not an environment: the worker must refuse it. */
export const notAnEnvironment: { readonly name: string; readonly realms: readonly string[] } = {
  name: 'broken',
  realms: ['worker'],
}

/** An environment for the `realm` tier only: the worker must refuse it. */
export const contextOnlyEnvironment: Environment<'context-only', Record<string, never>> = {
  name: 'context-only',
  realms: ['context'],
  setup() {
    throw new Error('never set up')
  },
}
