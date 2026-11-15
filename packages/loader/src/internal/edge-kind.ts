// The kind an edge resolves as (`ModulePolicy.edgeResolveKind`). `as-written` keeps the edge's own;
// `importer-format` gives every edge of a module the kind of the module it is in, `import` for one
// run as an ES module and `require` for any other, by the rule `ModulePolicy.edgeResolveKind`
// states (the extension, the nearest `package.json`'s `type`, `esmExtensions`, and whether Node
// has `vm.SyntheticModule` at all).
import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import * as vm from 'node:vm'
import type { LoaderOptions, ResolveKind } from '@provino/types'

/** What a lookup reads of the loader's options. */
export type EdgeKindOptions = Pick<LoaderOptions, 'esmExtensions'> & {
  readonly policy: Pick<LoaderOptions['policy'], 'edgeResolveKind'>
}

/** What an `importer-format` lookup remembers for one worker: by importer, and by directory. */
export interface EdgeKindState {
  readonly options: EdgeKindOptions
  /** Whether Node runs ES modules in `vm` at all (`vm.SyntheticModule`); none means every module is CommonJS. */
  readonly vmModules: boolean
  /** Whether a module runs as an ES module, by its path. */
  readonly esmByPath: Map<string, boolean>
  /** Whether the nearest `package.json` from a directory says `"type": "module"`, by directory. */
  readonly moduleTypeByDir: Map<string, boolean>
}

/** `vm.SyntheticModule` exists only under `--experimental-vm-modules`. */
const VM_MODULES = typeof vm.SyntheticModule === 'function'

/** `vmModules` is this process's answer; a test passes its own. */
export function createEdgeKindState(
  options: EdgeKindOptions,
  vmModules: boolean = VM_MODULES,
): EdgeKindState {
  return { options, vmModules, esmByPath: new Map(), moduleTypeByDir: new Map() }
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
  if (!state.vmModules) return false
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
