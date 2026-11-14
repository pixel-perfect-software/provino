// Constructors for the collector's suite nodes and file state, with the handles `LazyHost`
// exposes (Track 6: slots per suite, teardowns and a signal per file), and the tree helpers.
import type { FileHandle, RunMode, SuiteHandle, TaskId } from '@provino/types'
import type { FileState, InheritedOptions, SuiteNode, TestNode, UserFn } from '../internal/model.ts'
import type { Site } from './location.ts'

interface SuiteInit {
  readonly type: 'file' | 'suite'
  readonly name: string
  readonly parent: SuiteNode | null
  readonly file: FileState
  readonly site: Site | null
  readonly declared: RunMode | undefined
  readonly conditionSkip: boolean
  readonly each: boolean
  readonly options: InheritedOptions
  readonly concurrent: boolean | undefined
  readonly body: UserFn | undefined
  readonly bodyArgs: readonly unknown[]
}

/** A new suite node and its `SuiteHandle`, registered in its file's `suites`. */
export function newSuiteNode(init: SuiteInit): SuiteNode {
  const handle: SuiteHandle = {
    name: init.name,
    parent: init.parent?.handle,
    file: init.file.handle,
    slots: new Map(),
  }
  const node: SuiteNode = {
    type: init.type,
    name: init.name,
    parent: init.parent,
    file: init.file,
    site: init.site,
    declared: init.declared,
    mode: init.declared ?? 'run',
    skipReason: init.conditionSkip
      ? 'condition'
      : init.declared === 'skip'
        ? 'modifier'
        : undefined,
    id: '' as TaskId,
    each: init.each,
    children: [],
    hooks: {
      beforeAll: [],
      beforeEach: [],
      afterEach: [],
      afterAll: [],
      aroundEach: [],
      aroundAll: [],
    },
    options: init.options,
    concurrent: init.concurrent,
    shuffle: false,
    describeRetry: undefined,
    body: init.body,
    bodyArgs: init.bodyArgs,
    handle,
    task: undefined,
  }
  init.file.suites.set(handle, node)
  return node
}

/** A new file with its root suite. */
export function newFileState(path: string, relativePath: string, signal: AbortSignal): FileState {
  // The file, its root suite and their handles refer to each other. The getters read `root`, which
  // is assigned before anything calls them (`newSuiteNode` reads neither).
  const handle: FileHandle = {
    name: relativePath,
    get root(): SuiteHandle {
      return root.handle
    },
    slots: new Map(),
    teardowns: [],
    signal,
  }
  const file: FileState = {
    path,
    relativePath,
    get root(): SuiteNode {
      return root
    },
    handle,
    errors: [],
    collected: false,
    onCollected: [],
    lifecycle: undefined,
    suites: new WeakMap(),
  }
  const root = newSuiteNode({
    type: 'file',
    name: relativePath,
    parent: null,
    file,
    site: null,
    declared: undefined,
    conditionSkip: false,
    each: false,
    options: { tags: [], meta: {} },
    concurrent: undefined,
    body: undefined,
    bodyArgs: [],
  })
  return file
}

/** Whether a file is still collecting: registrations go into it, and `LazyHost` may change it. */
export function isOpen(file: FileState | undefined): file is FileState {
  return file !== undefined && !file.collected
}

/** Every node below `suite` in one list, depth first, parents before children. */
export function walk(suite: SuiteNode): Array<SuiteNode | TestNode> {
  const nodes: Array<SuiteNode | TestNode> = []
  const visit = (parent: SuiteNode): void => {
    for (const child of parent.children) {
      nodes.push(child)
      if (child.type !== 'test') visit(child)
    }
  }
  visit(suite)
  return nodes
}
