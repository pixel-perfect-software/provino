// Constructors for the collector's suite nodes and file state, with the handles `LazyHost`
// exposes (Track 6: slots per suite, teardowns and a signal per file).
import type { FileHandle, RunMode, SuiteHandle, TaskId } from '@provino/types'
import type { FileState, InheritedOptions, SuiteNode, UserFn } from '../internal/model.ts'
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

/** A new suite node and its `SuiteHandle`. */
export function newSuiteNode(init: SuiteInit): SuiteNode {
  const handle: SuiteHandle = {
    name: init.name,
    parent: init.parent?.handle,
    file: init.file.handle,
    slots: new Map(),
  }
  return {
    type: init.type,
    name: init.name,
    parent: init.parent,
    file: init.file,
    site: init.site,
    declared: init.declared,
    mode: init.declared ?? 'run',
    skipReason: init.conditionSkip ? 'condition' : undefined,
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
    body: init.body,
    bodyArgs: init.bodyArgs,
    handle,
  }
}

/** A new file with its root suite. */
export function newFileState(path: string, relativePath: string, signal: AbortSignal): FileState {
  // The file, its root suite and their handles refer to each other: the getters close over
  // `root`, which is assigned before anything can read them.
  let root: SuiteNode | undefined
  const rootNode = (): SuiteNode => {
    if (root === undefined) throw new Error('unreachable: the root suite is read before it exists')
    return root
  }
  const handle: FileHandle = {
    name: relativePath,
    get root(): SuiteHandle {
      return rootNode().handle
    },
    slots: new Map(),
    teardowns: [],
    signal,
  }
  const file: FileState = {
    path,
    relativePath,
    get root(): SuiteNode {
      return rootNode()
    },
    handle,
    errors: [],
    collected: false,
    onCollected: [],
  }
  root = newSuiteNode({
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
