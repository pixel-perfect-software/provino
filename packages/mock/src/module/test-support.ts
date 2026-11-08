// Shared by this directory's tests. Not exported from the package. Two module policies at the ends
// of the space (`jestLike`, `vitestLike`), a fake resolver, and a registry builder. Neither is a
// claim about any runner: `@provino/dialect-jest` and the harness's mod corpus own that.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import type { ModulePolicy, ResolveContext, ResolveResult, Resolver } from '@provino/types'
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

/** A real temp directory removed after the enclosing suite, with a `write` that makes an empty file. */
export function tempTree(prefix: string): {
  readonly dir: string
  readonly write: (path: string) => string
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    write(path) {
      const file = join(dir, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '')
      return file
    },
  }
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
