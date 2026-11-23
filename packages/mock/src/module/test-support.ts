// Shared by this directory's tests. Not exported from the package. Two module policies at the ends
// of the space (`jestLike`, `vitestLike`), a fake resolver, and a registry builder. Neither is a
// claim about any runner: `@provino/dialect-jest` and the harness's mod corpus own that.

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModulePolicy, ResolveContext, ResolveResult, Resolver } from '@provino/types'
import { afterAll, beforeAll } from 'provino'
import { neutral, neutralModule } from '../internal/test-support.ts'
import { createMockRegistry } from '../registry.ts'
import { createModuleMockRegistry, type ModuleMockRegistry } from './registry.ts'

export const vitestLike: ModulePolicy = neutralModule

export const jestLike: ModulePolicy = {
  ...neutralModule,
  factoryShape: 'module-value',
  rootMocksAutoApply: true,
  awaitFactory: false,
  missingFactoryExport: 'undefined',
  requireVirtualFlag: true,
  mockValueOwner: 'module-registry',
  mockResolveKind: 'require',
  edgeResolveKind: 'as-written',
  moduleSyncCondition: 'never',
  mocksReachShared: true,
  reevaluateHookingExternals: false,
  stackFrameNames: 'engine',
  automockShape: 'metadata',
  messages: {
    'module-missing': "Cannot find module '{specifier}' from '{from}' (hint)",
  },
}

/** A resolver whose answer is a file path, or `null`/`undefined` for not found. */
export function resolverBy(
  answer: (specifier: string, context: ResolveContext) => string | null | undefined,
): Resolver {
  return {
    fingerprint: 'fake',
    invalidate() {},
    resolve(specifier: string, context: ResolveContext): ResolveResult {
      const path = answer(specifier, context)
      if (path !== undefined && path !== null) {
        return { type: 'file', path, format: 'cjs', packageJson: null, mappedBy: null }
      }
      return {
        type: 'not-found',
        specifier,
        importer: context.importer,
        tried: [],
        mappedBy: null,
      }
    },
  }
}

export function fakeResolver(files: Readonly<Record<string, string>>): Resolver {
  return resolverBy((specifier) => files[specifier])
}

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

export interface TempTree {
  readonly dir: string
  /** The path of an empty file under `dir`, which the tree has once it is made. */
  readonly write: (path: string) => string
}

interface MakeableTree extends TempTree {
  /** Makes `dir` and every file `write` named before (a later `write` makes its file at once). */
  readonly make: () => void
}

/** A temp directory named now and made by `make()`, removed when the test file ends. */
function newTree(prefix: string): MakeableTree {
  const dir = join(tmpdir(), `${prefix}${randomBytes(6).toString('hex')}`)
  const waiting: string[] = []
  let ready = false
  const create = (file: string): void => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
  return {
    dir,
    write(path) {
      const file = join(dir, path)
      if (ready) create(file)
      else waiting.push(file)
      return file
    },
    make() {
      if (ready) return
      mkdirSync(dir)
      made.push(dir)
      ready = true
      for (const file of waiting) create(file)
    },
  }
}

/**
 * A temp directory named now and made in a `beforeAll`: call it in a `describe` body or at module
 * scope. Those run when a file is only listed (`-t` with a name no test has), and a listing runs no
 * hook, so the tree the file's tests share is made only when a test runs.
 */
export function deferredTree(prefix: string): TempTree {
  const { make, ...tree } = newTree(prefix)
  beforeAll(make)
  return tree
}

/** A real temp directory made now (call it in a test), with a `write` that makes an empty file. */
export function tempTree(prefix: string): TempTree {
  const tree = newTree(prefix)
  tree.make()
  return tree
}

export interface Harness {
  readonly registry: ModuleMockRegistry
  /** What `loadActual` was asked, in order: `[id, importer]`. */
  readonly loads: Array<readonly [string, string]>
}

export function build(options: {
  readonly policy: ModulePolicy
  readonly files?: Readonly<Record<string, string>>
  readonly roots?: readonly string[]
  readonly actuals?: Readonly<Record<string, unknown>>
  /** Replaces the fake resolver, for a test that needs the resolve kind to matter. */
  readonly resolver?: Resolver
}): Harness {
  const loads: Array<readonly [string, string]> = []
  const registry = createModuleMockRegistry({
    policy: options.policy,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: options.resolver ?? fakeResolver(options.files ?? {}),
    roots: options.roots ?? ['/proj'],
    extensions: ['.ts', '.js'],
    loadActual(id, importer) {
      loads.push([id, importer])
      return options.actuals?.[id]
    },
  })
  return { registry, loads }
}
