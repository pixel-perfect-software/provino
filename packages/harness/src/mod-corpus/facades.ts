// The per-module `jest` and `vi` of the mod corpus (B13b, T4.7): local objects over the fake
// loader's module-system calls, one pair per module so `from` is the calling file. The mock
// functions come from the shipped `jestGlobals` under Jest and from the corpus's local `vi` build
// under Vitest. B13c replaces both with the shipped facades and runs the same goldens (T4.8).
import { type JestGlobalsHost, jestGlobals } from '@provino/dialect-jest/runtime'
import { automock, createMockFn, type MockRegistry } from '@provino/mock'
import type { MockFactory, MockPolicy, MockSpec, ModulePolicy } from '@provino/types'
import { createViFacade } from '../mock-corpus/run-mock.ts'
import type { Facades, LoaderOps } from './fake-loader.ts'

export interface FacadeEnv {
  readonly facade: 'jest' | 'vi'
  readonly policy: ModulePolicy
  readonly mockPolicy: MockPolicy
  readonly mocks: MockRegistry
  readonly jestHost: JestGlobalsHost
  /** Registrations go nowhere: the non-vacuity check's registry that decides nothing is mocked. */
  readonly inert?: boolean
  readonly stubs: Parameters<typeof createViFacade>[2]
}

interface MockOptions {
  readonly virtual?: boolean
  readonly spy?: boolean
}

/** Builds the facades for the module at `from`. The other name is `undefined`, as in a real run. */
export function createFacades(env: FacadeEnv, from: string, ops: LoaderOps): Facades {
  const { registry } = ops
  const register = (specifier: string, spec: MockSpec, virtual?: boolean): void => {
    if (env.inert === true) return
    registry.register(specifier, spec, { from, ...(virtual === true ? { virtual } : {}) })
  }
  const base: Record<string, unknown> =
    env.facade === 'jest'
      ? { ...jestGlobals(env.jestHost).jest }
      : createViFacade(env.mockPolicy, env.mocks, env.stubs)

  const specFor = (factory: unknown, options: MockOptions | undefined): MockSpec =>
    typeof factory === 'function'
      ? { kind: 'factory', factory: factory as MockFactory }
      : { kind: 'automock', spy: options?.spy === true }
  const chain =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A): unknown => {
      run(...args)
      return base
    }
  const unmock = chain((specifier: string) => register(specifier, { kind: 'unmock' }))

  const shared: Record<string, unknown> = {
    unmock,
    resetModules: chain(() => ops.resetModules()),
  }
  if (env.facade === 'jest') {
    const mock = (specifier: string, factory?: unknown, options?: MockOptions): void =>
      register(specifier, specFor(factory, options), options?.virtual)
    Object.assign(base, shared, {
      mock: chain(mock),
      doMock: chain(mock),
      dontMock: unmock,
      deepUnmock: unmock,
      requireActual: (specifier: string): unknown => ops.actual(specifier, from),
      requireMock: (specifier: string): unknown => ops.mockOf(specifier, from),
      isolateModules: chain((fn: () => unknown) => ops.isolate(fn)),
      enableAutomock: chain(() => env.inert === true || registry.setAutomock(true)),
      disableAutomock: chain(() => env.inert === true || registry.setAutomock(false)),
      createMockFromModule: (specifier: string): unknown =>
        automock(
          ops.actualForAutomock(specifier, from),
          env.policy.automockShape,
          'automock',
          (o) => createMockFn(env.mockPolicy, env.mocks, o),
        ),
    })
    return { jest: base, vi: undefined }
  }
  const mock = (specifier: string, factory?: unknown): void => {
    const options =
      factory !== null && typeof factory === 'object' ? (factory as MockOptions) : undefined
    register(specifier, specFor(factory, options))
  }
  Object.assign(base, shared, {
    mock: chain(mock),
    doMock: chain(mock),
    doUnmock: unmock,
    importActual: (specifier: string): unknown => ops.actual(specifier, from),
    importMock: (specifier: string): Promise<unknown> =>
      new Promise((done) => done(ops.mockOf(specifier, from))),
    hoisted: <T>(fn: () => T): T => fn(),
    mocked: <T>(value: T): T => value,
  })
  return { jest: undefined, vi: base }
}
