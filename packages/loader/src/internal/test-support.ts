// Shared by the loader's mock tests (`mocks.test.ts`, `review-regressions.test.ts`). Not exported
// from the package. The policies are the two ends of the space that matter here, not any dialect's
// values: `@provino/dialect-jest` and the harness's mod corpus own those.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { createMockRegistry, createModuleMockRegistry } from '@provino/mock'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type {
  FileRegistry,
  FileRegistryOptions,
  HoistPolicy,
  Loader,
  LoaderOptions,
  ModuleId,
  ModuleMockRegistry,
  ModulePolicy,
} from '@provino/types'
import { createLoader } from '../loader.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A module id under `root`: the parent an import or `require` comes from. */
export function at(root: string, file: string): ModuleId {
  return join(root, file) as ModuleId
}

/** Writes `files` into a fresh temp directory (its real path), removed after the test file. */
export function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-mocks-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** A Jest-shaped hoist policy for these tests only (not the dialect's value). */
export const HOIST: HoistPolicy = {
  id: 'loader-test',
  objects: [{ kind: 'global', name: 'mocker' }],
  hoistCalls: { mock: 'path-factory-options', unmock: 'one-string' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: true,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages: {
    HOIST_FACTORY_OUT_OF_SCOPE: 'out of scope',
    HOIST_FACTORY_NOT_FUNCTION: 'not a function',
    HOIST_NOT_TOP_LEVEL: 'not top level',
    HOIST_NESTED: 'nested',
    HOIST_EXPORTED: 'exported',
    HOIST_EXPORTED_VALUE: 'exported value',
  },
}

/** Jest's shapes at the ends that matter here: a factory returns `module.exports`, synchronously. */
export const JESTISH: ModulePolicy = {
  ...neutralPolicy.module,
  factoryShape: 'module-value',
  interopDefault: 'babel',
  awaitFactory: false,
  actual: 'sync-require',
  requireVirtualFlag: true,
  missingFactoryExport: 'undefined',
  mockValueOwner: 'module-registry',
  mockResolveKind: 'require',
  mocksReachShared: true,
}

/** Vitest's: a factory is a namespace and awaited, the actual module comes through `import`. */
export const VITESTISH: ModulePolicy = {
  ...neutralPolicy.module,
  factoryShape: 'namespace',
  interopDefault: 'node',
  awaitFactory: true,
  actual: 'async-import',
  requireVirtualFlag: false,
  missingFactoryExport: 'undefined',
  mockValueOwner: 'registration',
  mockResolveKind: 'import',
  mocksReachShared: false,
  automockShape: 'deep',
}

export function loaderFor(
  root: string,
  options: {
    readonly policy?: Partial<ModulePolicy>
    readonly hoist?: HoistPolicy | null
    readonly graphCache?: string | null
    readonly inlineBudget?: number
    readonly onWarning?: LoaderOptions['onWarning']
  } = {},
): Loader {
  return createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({
      root,
      mappers: [],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      tsconfig: false,
    }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: options.hoist === undefined ? HOIST : options.hoist,
      cache: false,
    }),
    policy: { ...JESTISH, ...options.policy },
    moduleScope: { names: ['mocker'] },
    ...(options.graphCache === undefined ? {} : { graphCache: options.graphCache }),
    ...(options.inlineBudget === undefined ? {} : { inlineBudget: options.inlineBudget }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  })
}

export interface FileWithMocksOptions {
  readonly tier?: FileRegistryOptions['tier']
  /** The module-mock registry's policy: the loader's, given the same way. */
  readonly policy?: Partial<ModulePolicy>
  readonly wrap?: (registry: ModuleMockRegistry) => ModuleMockRegistry
}

/** A file registry whose modules get a `mocker` that registers through it, over a real registry. */
export function fileWithMocks(
  loader: Loader,
  file: string,
  options: FileWithMocksOptions = {},
): { readonly files: FileRegistry; readonly mocks: () => ModuleMockRegistry } {
  let mocks: ModuleMockRegistry | undefined
  let files: FileRegistry | undefined
  const current = (): FileRegistry => {
    if (files === undefined) throw new Error('no file registry')
    return files
  }
  const wrap = options.wrap ?? ((registry: ModuleMockRegistry) => registry)
  files = loader.createFileRegistry(file, {
    tier: options.tier ?? 'registry',
    moduleMocks: (context) => {
      mocks = wrap(
        createModuleMockRegistry({
          policy: { ...JESTISH, ...options.policy },
          mockPolicy: neutralPolicy.mock,
          mocks: createMockRegistry(),
          resolver: context.resolver,
          roots: [dirname(file)],
          extensions: ['.ts', '.js'],
          conditions: context.conditions,
          loadActual: context.loadActual,
        }),
      )
      return mocks
    },
    moduleScope: (from) => ({
      mocker: {
        mock: (specifier: string, factory?: () => unknown, mockOptions?: { virtual?: boolean }) =>
          current().registerMock(
            specifier,
            from,
            typeof factory === 'function'
              ? { kind: 'factory', factory }
              : { kind: 'automock', spy: false },
            mockOptions ?? {},
          ),
        unmock: (specifier: string) => current().unregisterMock(specifier, from),
        requireActual: (specifier: string) => current().requireActual(specifier, from),
      },
    }),
  })
  return {
    files,
    mocks: () => {
      if (mocks === undefined) throw new Error('no module-mock registry')
      return mocks
    },
  }
}
