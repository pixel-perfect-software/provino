// The kind an edge resolves as (`ModulePolicy.edgeResolveKind`) and the conditions it is looked up
// with (`ModulePolicy.moduleSyncCondition`). `as-written` keeps the edge's own kind;
// `importer-format` gives every edge of a module the kind of the module it is in, `import` for one
// run as an ES module and `require` for any other, by the rule `ModulePolicy.edgeResolveKind`
// states (the extension, the nearest `package.json`'s `type`, `esmExtensions`, and whether Node
// has `vm.SyntheticModule` at all). `import-and-sync-require` adds `module-sync` to an
// `import`-kind lookup, and to a `require`-kind one when Node can evaluate an ES module graph
// synchronously (`vm.SourceTextModule.prototype.hasAsyncGraph`).
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
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

/** What an `importer-format` lookup remembers for one worker: by importer, and by manifest. */
export interface EdgeKindState {
  readonly options: EdgeKindOptions
  /** What this Node can do, read on first use: `as-written` with `never` never asks. */
  readonly runtime: () => RuntimeCapabilities
  /** The conditions of a lookup that adds no `module-sync`: the loader's own. */
  readonly conditions: readonly string[]
  /** The same with `module-sync`, for the lookups `moduleSyncCondition` gives it. */
  readonly withModuleSync: readonly string[]
  /** Whether a module runs as an ES module, by its path. */
  readonly esmByPath: Map<string, boolean>
  /** The `"type"` a `package.json` gives (`undefined` for none), by the manifest's path. */
  readonly typeByManifest: Map<string, string | undefined>
  /** The nearest `package.json` at or above a directory (`null` for none), by the directory. */
  readonly manifestByDir: Map<string, string | null>
  /** Whether `path` is a file; a test passes a counting one. */
  readonly isFile: (path: string) => boolean
}

/** Whether `path` is a file, without throwing for a missing one (an ENOENT costs a `NodeError`). */
function isFileOnDisk(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
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
function probeRuntime(): RuntimeCapabilities {
  const sourceTextModule = vmMember('SourceTextModule')
  return {
    vmModules: typeof vmMember('SyntheticModule') === 'function',
    syncEvaluate:
      typeof sourceTextModule === 'function' &&
      typeof Reflect.get(sourceTextModule.prototype as object, 'hasAsyncGraph') === 'function',
  }
}

/** `runtime` is this process's answers, probed when first asked for; a test passes its own. */
export function createEdgeKindState(
  options: EdgeKindOptions,
  runtime?: RuntimeCapabilities,
  isFile: (path: string) => boolean = isFileOnDisk,
): EdgeKindState {
  const conditions = conditionsOf(options)
  let capabilities = runtime
  return {
    options,
    runtime: () => (capabilities ??= probeRuntime()),
    conditions,
    withModuleSync: conditions.includes('module-sync')
      ? conditions
      : [...conditions, 'module-sync'],
    esmByPath: new Map(),
    typeByManifest: new Map(),
    manifestByDir: new Map(),
    isFile,
  }
}

/** The `type` the `package.json` at `manifest` gives; an unreadable or broken one gives none. */
function packageTypeOf(manifest: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const type = (parsed as { readonly type?: unknown }).type
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

/**
 * The nearest `package.json` at or above `dir`, or `undefined` for none. The search stops at a
 * `node_modules` directory, as Node's own (`module.findPackageJSON`) does. The answer is kept per
 * directory, and every directory the walk passed gets it, so a directory's files cost one lookup
 * and a walk ends at the first directory already known.
 */
function nearestManifest(state: EdgeKindState, dir: string): string | undefined {
  const passed: string[] = []
  let found: string | null = null
  let current = dir
  for (;;) {
    const known = state.manifestByDir.get(current)
    if (known !== undefined) {
      found = known
      break
    }
    passed.push(current)
    if (basename(current) === 'node_modules') break
    const candidate = join(current, 'package.json')
    if (state.isFile(candidate)) {
      found = candidate
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const directory of passed) state.manifestByDir.set(directory, found)
  return found ?? undefined
}

/**
 * The `type` of the nearest `package.json` at or above the file at `path` (`"module"`,
 * `"commonjs"`), or `undefined` for none, or one that does not parse: CommonJS, as Jest
 * has it. Each manifest is read once.
 */
export function packageTypeAt(state: EdgeKindState, path: string): string | undefined {
  const manifest = nearestManifest(state, dirname(path))
  if (manifest === undefined) return undefined
  if (state.typeByManifest.has(manifest)) return state.typeByManifest.get(manifest)
  const type = packageTypeOf(manifest)
  state.typeByManifest.set(manifest, type)
  return type
}

/**
 * Whether the file at `path` is CommonJS by its name or its package, whatever its source holds:
 * `.cjs`, or a `.js` whose nearest `package.json` says `"type": "commonjs"` (jest-runtime's
 * `Resolution.isExplicitlyCommonjs`, jest-resolve's `isExplicitlyCommonjsPackage`).
 */
export function isExplicitlyCommonjs(state: EdgeKindState, path: string): boolean {
  const extension = extname(path)
  if (extension === '.cjs') return true
  return extension === '.js' && packageTypeAt(state, path) === 'commonjs'
}

/** Whether the module at `path` runs as an ES module under `importer-format`. */
export function runsAsEsm(state: EdgeKindState, path: string): boolean {
  if (!state.runtime().vmModules) return false
  const known = state.esmByPath.get(path)
  if (known !== undefined) return known
  const extension = extname(path)
  let answer: boolean
  if (extension === '.mjs' || extension === '.wasm') answer = true
  else if (extension === '.cjs') answer = false
  else if (extension === '.js') answer = packageTypeAt(state, path) === 'module'
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
  return kind !== 'require' || state.runtime().syncEvaluate
    ? state.withModuleSync
    : state.conditions
}
