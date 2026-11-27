// The native API's module-mock members (B27j, B28): `mock`, `unmock`, `importActual` and `requireActual`, over the file
// registry running now (`host.registry()`), so a registration lives and dies with its file.
import type { MockFactory, MockSpec, ModuleId } from '@provino/types'
import { ProvinoApiError } from './errors.ts'
import type { ApiHost, ProvinoApi } from './types.ts'

/**
 * The names of `ProvinoApi` that act on module mocks. They resolve a specifier from the module that
 * imported them, so they are served per module and are never globals.
 * @public
 */
export const PROVINO_MODULE_MOCK_NAMES: readonly [
  'mock',
  'unmock',
  'importActual',
  'requireActual',
] = ['mock', 'unmock', 'importActual', 'requireActual'] as const

/**
 * A name in `PROVINO_MODULE_MOCK_NAMES`.
 * @public
 */
export type ProvinoModuleMockName = (typeof PROVINO_MODULE_MOCK_NAMES)[number]

/** `null` as itself, anything else by its `typeof`: for a misuse message. */
function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value
}

function assertSpecifier(
  specifier: unknown,
  member: ProvinoModuleMockName,
): asserts specifier is string {
  if (typeof specifier !== 'string') {
    throw new ProvinoApiError(
      'API_MOCK_SPECIFIER',
      `${member}() takes the module's specifier as a string, but received ${describeType(specifier)}.`,
    )
  }
}

/** V8's text for a binding read in its temporal dead zone. */
const UNINITIALIZED = /^Cannot access '([^']+)' before initialization$/

/** The hoister's name for the file's N-th import moved below the mocks (`LATE_IMPORT`, D38). */
const LATE_IMPORT = /^__provino_import_\d+__$/

/**
 * The user's name for `binding` in `factory`'s source: itself, or for one of the hoister's late
 * imports the export read through it there (`__provino_import_1__.b` is `b`).
 */
function bindingName(binding: string, factory: (...args: never[]) => unknown): string {
  if (!LATE_IMPORT.test(binding)) return `\`${binding}\``
  const read = new RegExp(`${binding}\\.([A-Za-z_$][\\w$]*)`).exec(String(factory))?.[1]
  return read === undefined ? 'an import of this file' : `the import \`${read}\``
}

/**
 * The factory, with a read of a binding not yet initialized (a later import or the file's own
 * top-level code: the factory runs while the file's imports load) turned into
 * `API_MOCK_FACTORY_UNINITIALIZED`, naming the binding as the user wrote it. Anything else passes
 * through as it was.
 */
function guarded(specifier: string, factory: MockFactory): MockFactory {
  const explain = (error: unknown): never => {
    const binding =
      error instanceof ReferenceError ? UNINITIALIZED.exec(error.message)?.[1] : undefined
    if (binding === undefined) throw error
    throw new ProvinoApiError(
      'API_MOCK_FACTORY_UNINITIALIZED',
      `mock('${specifier}'): the factory read ${bindingName(binding, factory)} before it was initialized. A factory runs when '${specifier}' first loads, which is while the file's imports load: it can't read a later import or the file's own top-level variables. Import it inside the factory (\`await import(...)\`), or use the \`importOriginal\` it is given.`,
      { cause: error },
    )
  }
  return (importOriginal) => {
    let result: unknown
    try {
      result = factory(importOriginal)
    } catch (error) {
      explain(error)
    }
    return result instanceof Promise ? result.catch(explain) : result
  }
}

/** No factory is the neutral automock (`automockShape: 'deep'`); a function is the factory. */
function specOf(specifier: string, factory: unknown): MockSpec {
  if (factory === undefined) return { kind: 'automock', spy: false }
  if (typeof factory === 'function') {
    return { kind: 'factory', factory: guarded(specifier, factory as MockFactory) }
  }
  throw new ProvinoApiError(
    'API_MOCK_FACTORY',
    `mock() takes a factory function (or none, for an automock), but received ${describeType(factory)}.`,
  )
}

/**
 * Under isolation `none` every module but the test file loads once per worker, so a `mock` at a
 * helper's top level would register for the first file that imports it and never again. Refused,
 * where the call is made, rather than half applied.
 */
function assertRegistersPerFile(host: ApiHost, from: string | null, member: string): void {
  if (from === null) return
  const registry = host.registry()
  if (registry.tier !== 'none' || from === registry.file) return
  throw new ProvinoApiError(
    'API_MOCK_SHARED_MODULE',
    `${member}() was called from ${from}, which isolation 'none' loads once per worker: its mock would apply only to the first test file that imports it. Call ${member}() in each test file, or use isolation 'registry'.`,
  )
}

/**
 * `mock`, `unmock`, `importActual` and `requireActual` for the module `from`: a relative specifier resolves from
 * it, as an import of it would. `null` (the slot, which no module owns) resolves from the test
 * file running now. Each acts on the file registry running now, so a mock never outlives its file.
 * @internal
 */
export function moduleMocksOver(
  host: ApiHost,
  from: string | null,
): Pick<ProvinoApi, ProvinoModuleMockName> {
  const parent = from as ModuleId | null
  return {
    mock: (specifier, factory) => {
      assertSpecifier(specifier, 'mock')
      assertRegistersPerFile(host, from, 'mock')
      host.registry().registerMock(specifier, parent, specOf(specifier, factory))
    },
    unmock: (specifier) => {
      assertSpecifier(specifier, 'unmock')
      assertRegistersPerFile(host, from, 'unmock')
      host.registry().unregisterMock(specifier, parent)
    },
    importActual: async <T extends object>(specifier: string): Promise<T> => {
      assertSpecifier(specifier, 'importActual')
      return await host.registry().importActual<T>(specifier, parent)
    },
    requireActual: <T extends object>(specifier: string): T => {
      assertSpecifier(specifier, 'requireActual')
      return host.registry().requireActual<T>(specifier, parent)
    },
  }
}
