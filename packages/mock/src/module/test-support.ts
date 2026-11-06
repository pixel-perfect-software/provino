// Shared by this directory's tests. Not exported from the package. Two module policies at the ends
// of the space (`jestLike`, `vitestLike`), a fake resolver, and a registry builder. Neither is a
// claim about any runner: `@provino/dialect-jest` and the harness's mod corpus own that.

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
  resetModulesReRunsFactory: true,
  requireVirtualFlag: true,
  automockShape: 'metadata',
  messages: {
    'module-missing': "Cannot find module '{specifier}' from '{from}' (hint)",
  },
}

export function fakeResolver(files: Readonly<Record<string, string>>): Resolver {
  return {
    fingerprint: 'fake',
    invalidate() {},
    resolve(specifier: string, context: ResolveContext): ResolveResult {
      const path = files[specifier]
      if (path !== undefined) {
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
}): Harness {
  const loads: Array<readonly [string, string]> = []
  const registry = createModuleMockRegistry({
    policy: options.policy,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver(options.files ?? {}),
    roots: options.roots ?? ['/proj'],
    extensions: ['.ts', '.js'],
    loadActual(id, importer) {
      loads.push([id, importer])
      return options.actuals?.[id]
    },
  })
  return { registry, loads }
}
