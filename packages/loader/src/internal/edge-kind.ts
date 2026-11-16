// The kind an edge resolves as (`ModulePolicy.edgeResolveKind`) and the conditions it is looked up
// with (`ModulePolicy.moduleSyncCondition`). `as-written` keeps the edge's own kind;
// `importer-format` gives every edge of a module the kind of the module it is in, `import` for one
// run as an ES module and `require` for any other, by the rule `ModulePolicy.edgeResolveKind`
// states (the extension, the nearest `package.json`'s `type`, `esmExtensions`, and whether Node
// has `vm.SyntheticModule` at all). `import-and-sync-require` adds `module-sync` to an
// `import`-kind lookup, and to a `require`-kind one when Node can evaluate an ES module graph
// synchronously (`vm.SourceTextModule.prototype.hasAsyncGraph`).
import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import * as vm from 'node:vm'
import type { LoaderOptions, ResolveKind } from '@provino/types'
import { conditionsOf } from '../graph/conditions.ts'

/** What a lookup reads of the loader's options. */
export type EdgeKindOptions = Pick<LoaderOptions, 'esmExtensions' | 'conditions'> & {
  readonly policy: Pick<LoaderOptions['policy'], 'edgeResolveKind' | 'moduleSyncCondition'>
}

/** What this process's Node can do, as the two policy keys read it. */
export interface RuntimeCapabilities {
  /** Node runs ES modules in `vm` at all (`vm.SyntheticModule`); none means every module is CommonJS. */
  readonly vmModules: boolean
  /** Node evaluates an ES module graph synchronously (`vm.SourceTextModule.prototype.hasAsyncGraph`). */
  readonly syncEvaluate: boolean
}

/** What an `importer-format` lookup remembers for one worker: by importer, and by directory. */
export interface EdgeKindState {
  readonly options: EdgeKindOptions
  readonly runtime: RuntimeCapabilities
  /** The conditions of a lookup that adds no `module-sync`: the loader's own. */
  readonly conditions: readonly string[]
  /** The same with `module-sync`, for the lookups `moduleSyncCondition` gives it. */
  readonly withModuleSync: readonly string[]
  /** Whether a module runs as an ES module, by its path. */
  readonly esmByPath: Map<string, boolean>
  /** Whether the nearest `package.json` from a directory says `"type": "module"`, by directory. */
  readonly moduleTypeByDir: Map<string, boolean>
}

/** A member of `node:vm` this Node may lack, read without its type (the flags decide). */
function vmMember(name: string): unknown {
  return Reflect.get(vm, name)
}

/**
 * This process's answers. `vm.SyntheticModule` and `vm.SourceTextModule` exist only under
 * `--experimental-vm-modules`, and `hasAsyncGraph` from Node 24.9, as jest-runtime's
 * `nodeCapabilities.ts` reads them.
 */
const RUNTIME: RuntimeCapabilities = (() => {
  const sourceTextModule = vmMember('SourceTextModule')
  return {
    vmModules: typeof vmMember('SyntheticModule') === 'function',
    syncEvaluate:
      typeof sourceTextModule === 'function' &&
      typeof Reflect.get(sourceTextModule.prototype as object, 'hasAsyncGraph') === 'function',
  }
})()

/** `runtime` is this process's answers; a test passes its own. */
export function createEdgeKindState(
  options: EdgeKindOptions,
  runtime: RuntimeCapabilities = RUNTIME,
): EdgeKindState {
  const conditions = conditionsOf(options)
  return {
    options,
    runtime,
    conditions,
    withModuleSync: conditions.includes('module-sync')
      ? conditions
      : [...conditions, 'module-sync'],
    esmByPath: new Map(),
    moduleTypeByDir: new Map(),
  }
}

/** The `type` of the nearest `package.json` above `dir` is `module`; a missing or broken one is not. */
function moduleTypeFrom(state: EdgeKindState, dir: string): boolean {
  const known = state.moduleTypeByDir.get(dir)
  if (known !== undefined) return known
  let text: string | undefined
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    text = undefined
  }
  let answer: boolean
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      answer =
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { readonly type?: unknown }).type === 'module'
    } catch {
      answer = false
    }
  } else {
    const parent = dirname(dir)
    answer = parent === dir ? false : moduleTypeFrom(state, parent)
  }
  state.moduleTypeByDir.set(dir, answer)
  return answer
}

/** Whether the module at `path` runs as an ES module under `importer-format`. */
export function runsAsEsm(state: EdgeKindState, path: string): boolean {
  if (!state.runtime.vmModules) return false
  const known = state.esmByPath.get(path)
  if (known !== undefined) return known
  const extension = extname(path)
  let answer: boolean
  if (extension === '.mjs' || extension === '.wasm') answer = true
  else if (extension === '.cjs') answer = false
  else if (extension === '.js') answer = moduleTypeFrom(state, dirname(path))
  else answer = (state.options.esmExtensions ?? []).includes(extension)
  state.esmByPath.set(path, answer)
  return answer
}

/** The kind a `kind` edge from `importer` resolves as, under the policy's `edgeResolveKind`. */
export function edgeKind(state: EdgeKindState, importer: string, kind: ResolveKind): ResolveKind {
  if (state.options.policy.edgeResolveKind === 'as-written' || kind === 'import-meta-resolve') {
    return kind
  }
  return runsAsEsm(state, importer) ? 'import' : 'require'
}

/**
 * The conditions a lookup of `kind` (the kind the edge resolves as) runs with, under the policy's
 * `moduleSyncCondition`; the resolver adds the kind's own `import` or `require`.
 */
export function edgeConditions(state: EdgeKindState, kind: ResolveKind): readonly string[] {
  if (state.options.policy.moduleSyncCondition === 'never') return state.conditions
  return kind !== 'require' || state.runtime.syncEvaluate ? state.withModuleSync : state.conditions
}
