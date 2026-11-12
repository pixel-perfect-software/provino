// Track 8 T8.3 (`@provino/env-jsdom`, realm `worker`). A fresh jsdom window per file, populated onto
// the worker's own global (R1 option B) and, when the file ends, closed and removed so that the
// global's names and descriptors are as they were. The semantics of what is copied are Vitest's
// (`@provino/env-shared`'s `populateGlobal`); the options and the error-event bridge follow
// Vitest's `jsdom` environment and Jest's `jest-environment-jsdom`.
import { populateGlobal, snapshotProperties } from '@provino/env-shared'
import type {
  Environment,
  EnvironmentInstance,
  EnvironmentOptionsMap,
  EnvironmentTeardownReport,
} from '@provino/types'
import type { ConstructorOptions, DOMWindow, JSDOM, VirtualConsole } from 'jsdom'
import { JsdomEnvironmentError } from './errors.ts'

/**
 * The options of the jsdom environment: `url`, `html`, `userAgent`, `pretendToBeVisual`,
 * `customExportConditions` (read by the policy's `environmentConditions`, not here) and `jsdom`,
 * anything else the `JSDOM` constructor takes.
 * @public
 */
export type JsdomEnvironmentOptions = EnvironmentOptionsMap['jsdom']

/** What `prepare` hands every `setup`: the classes of the project's jsdom, imported once. */
interface Prepared {
  readonly JSDOM: typeof JSDOM
  readonly VirtualConsole: typeof VirtualConsole
}

function isPrepared(value: unknown): value is Prepared {
  return (
    typeof value === 'object' &&
    value !== null &&
    'JSDOM' in value &&
    typeof value.JSDOM === 'function' &&
    'VirtualConsole' in value &&
    typeof value.VirtualConsole === 'function'
  )
}

/**
 * Node's own fetch family, which the window gets instead of jsdom's (jsdom has none, or one that
 * can't take a Node body). Vitest overrides the same names.
 */
const NODE_OVERRIDES = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'AbortController',
  'AbortSignal',
  'URLSearchParams',
] as const

/** Names jsdom lacks and Node has; copied when the window has none. */
const NODE_FILLS = [
  'structuredClone',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'TextEncoder',
  'TextDecoder',
] as const

/**
 * A window `error` event with no listener of the test's own is an uncaught exception, as in a
 * browser's console (Jest and Vitest do the same): the event is prevented and the error goes to
 * the process's `uncaughtException`, where the runtime charges it. Returns the way to remove it.
 */
function bridgeErrors(win: DOMWindow): () => void {
  let userListeners = 0
  const add = win.addEventListener.bind(win)
  const remove = win.removeEventListener.bind(win)
  const bridge = (event: ErrorEvent): void => {
    if (userListeners === 0 && event.error != null) {
      event.preventDefault()
      process.emit('uncaughtException', event.error)
    }
  }
  add('error', bridge as EventListener)
  const counted: typeof win.addEventListener = (...args: Parameters<typeof add>) => {
    if (args[0] === 'error') userListeners++
    return add(...args)
  }
  const uncounted: typeof win.removeEventListener = (...args: Parameters<typeof remove>) => {
    if (args[0] === 'error' && userListeners > 0) userListeners--
    return remove(...args)
  }
  win.addEventListener = counted
  win.removeEventListener = uncounted
  return () => {
    remove('error', bridge as EventListener)
  }
}

function constructorOptions(
  options: JsdomEnvironmentOptions,
  virtualConsole: VirtualConsole,
): ConstructorOptions {
  const { userAgent } = options
  return {
    pretendToBeVisual: options.pretendToBeVisual ?? true,
    runScripts: 'dangerously',
    url: options.url ?? 'http://localhost:3000',
    virtualConsole,
    ...(userAgent === undefined ? {} : { resources: { userAgent } }),
    // The user's own bag of `JSDOM` constructor options, free-form by design, goes last.
    ...(options.jsdom as ConstructorOptions | undefined),
  }
}

/**
 * The jsdom test environment.
 *
 * `prepare` imports the project's `jsdom` once per worker (a missing package is
 * `ENV_JSDOM_NOT_INSTALLED`). `setup` makes a new `JSDOM` from the options, puts its window on the
 * worker's `globalThis` with `populateGlobal` and returns that global. `teardown` closes the
 * window and puts the global back: first what `populateGlobal` changed, then every other
 * difference (a global the test added or changed) from a descriptor snapshot taken before the
 * window went on, so afterwards the global's property names and every original descriptor equal
 * what `setup` saw. A key it cannot restore is a warning, not a failure (decision D22): the
 * teardown returns a report naming it.
 *
 * Window `error` events with no listener of the test's own become uncaught exceptions.
 *
 * Only the `worker` realm is supported: `setup` throws `ENV_JSDOM_REALM_UNSUPPORTED` for
 * `context`, which needs the `realm` isolation tier (T2.8).
 *
 * Not copied from Vitest: its wrappers for `URL` and `Blob`/`FormData` interop between Node's
 * `fetch` and jsdom's `Blob`; a jsdom `Blob` is not accepted as a `fetch` body here.
 * @public
 */
export const jsdomEnvironment: Environment<'jsdom', JsdomEnvironmentOptions> = {
  name: 'jsdom',
  realms: ['worker'],
  async prepare(): Promise<Prepared> {
    try {
      const { JSDOM, VirtualConsole } = await import('jsdom')
      return { JSDOM, VirtualConsole }
    } catch (cause) {
      throw new JsdomEnvironmentError(
        'ENV_JSDOM_NOT_INSTALLED',
        "The jsdom environment needs the 'jsdom' package (version 26 to 30): install it as a dev dependency.",
        { cause },
      )
    }
  },
  setup(context, prepared): EnvironmentInstance {
    if (context.realm !== 'worker') {
      throw new JsdomEnvironmentError(
        'ENV_JSDOM_REALM_UNSUPPORTED',
        `The jsdom environment supports the 'worker' realm only, not '${context.realm}'. A vm-context window needs the 'realm' isolation tier (T2.8).`,
      )
    }
    if (!isPrepared(prepared)) {
      throw new JsdomEnvironmentError(
        'ENV_JSDOM_NOT_PREPARED',
        "The jsdom environment's setup needs what its prepare returned.",
      )
    }
    const { options } = context
    const virtualConsole = new prepared.VirtualConsole()
    virtualConsole.forwardTo(context.console)
    const dom = new prepared.JSDOM(
      options.html ?? '<!DOCTYPE html>',
      constructorOptions(options, virtualConsole),
    )
    const win = dom.window
    const clearErrors = bridgeErrors(win)

    const nodeGlobals: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
    const winGlobals: Record<string, unknown> = win as unknown as Record<string, unknown>
    winGlobals.Buffer = Buffer
    winGlobals.jsdom = dom
    for (const name of NODE_FILLS) {
      if (nodeGlobals[name] !== undefined && winGlobals[name] === undefined) {
        winGlobals[name] = nodeGlobals[name]
      }
    }
    for (const name of NODE_OVERRIDES) {
      if (nodeGlobals[name] !== undefined) winGlobals[name] = nodeGlobals[name]
    }

    const snapshot = snapshotProperties(globalThis)
    const populated = populateGlobal(globalThis, win, { bindFunctions: true })
    return {
      global: globalThis,
      teardown(): EnvironmentTeardownReport | undefined {
        clearErrors()
        win.close()
        populated.restore()
        const leaked = snapshot.restore()
        return leaked.length === 0 ? undefined : { leakedGlobals: leaked.map(String) }
      },
    }
  },
}
