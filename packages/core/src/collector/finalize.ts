// After collection (T5.3): stable ids, focus and filters, the empty-describe policy, full names,
// `dupIndex`, and the clone-safe `TaskNode` list (file first, parents before children).
//
// Focus has two algorithms, picked by `focus.scope`:
// - `file`: `.only` anywhere narrows the whole file; describes pass their mode to tests that
//   declare none, unless a describe.only has a direct test.only (jest-circus 30.5's
//   `finish_describe_definition` and `_runTest`).
// - `suite`: inside a suite that contains a `.only`, only those children run (Vitest 5.0's
//   `interpretTaskModes`).
import { hash } from 'node:crypto'
import type {
  CorePolicy,
  FileTask,
  RunMode,
  SuiteTask,
  TaskId,
  TaskNode,
  TestTask,
} from '@provino/types'
import { CoreError } from '../errors.ts'
import type { FileState, NodeSkipReason, SuiteNode, TestNode } from '../internal/model.ts'
import { parseSite, toPath } from './location.ts'
import { walk } from './nodes.ts'

/** Every node below the file root, depth first, parents before children: what each pass walks. */
type Nodes = ReadonlyArray<SuiteNode | TestNode>

/** Filters and settings that shape a collected file. */
export interface FinalizeOptions {
  readonly policy: CorePolicy
  readonly projectName: string
  /**
   * The file's id, when the caller (the coordinator, D23) assigned it; `fileIdOf` computes it
   * from `projectName` and the relative path otherwise. Every task id below the file derives from it.
   */
  readonly fileId?: TaskId
  readonly ci: boolean
  readonly testNamePattern: RegExp | undefined
  readonly testIds: ReadonlySet<string> | undefined
  /** Location filter: lines of tests or suites in the test file to run (Vitest's `file:line`). */
  readonly lines: ReadonlySet<number> | undefined
}

/** Assigns ids and full names, interprets modes, and returns the file's task list. */
export function finalize(file: FileState, options: FinalizeOptions): TaskNode[] {
  const testFile = toPath(file.path)
  const nodes = walk(file.root)
  assignIds(file, options.fileId ?? fileIdOf(options.projectName, file.relativePath))
  assignNames(file.root)
  parseLocations(file.root, nodes, testFile, options.policy.locationFrame === 'test-file')
  if (options.policy.focus.scope === 'file') interpretFileScope(file.root, options)
  else interpretSuiteScope(file.root, nodes, options)
  applyLineFilter(file, testFile, options)
  blockOnly(nodes, options)
  checkEmpty(file, nodes, options.policy)
  return toTasks(file, nodes, options.projectName, options.policy.timeouts.test)
}

/** A file's task id: a hash of the project name and its relative path (stable across runs). */
export function fileIdOf(projectName: string, relativePath: string): TaskId {
  return hash('sha1', `${projectName}\0${relativePath}`).slice(0, 10) as TaskId
}

function assignIds(file: FileState, fileId: TaskId): void {
  file.root.id = fileId
  const visit = (suite: SuiteNode): void => {
    suite.children.forEach((child, index) => {
      child.id = `${suite.id}_${index}` as TaskId
      if (child.type !== 'test') visit(child)
    })
  }
  visit(file.root)
}

/**
 * One full-name path in `assignNames`' trie: how many tests have exactly this full name, and the
 * paths one name longer. Same-named sibling suites share an entry, so their tests count together.
 */
interface NameEntry {
  tests: number
  next: Map<string, NameEntry> | undefined
}

/** Each test's full name, and `dupIndex`: how many earlier tests have the same full name. */
function assignNames(root: SuiteNode): void {
  const visit = (suite: SuiteNode, prefix: readonly string[], entry: NameEntry): void => {
    for (const child of suite.children) {
      const names = [...prefix, child.name]
      entry.next ??= new Map()
      let next = entry.next.get(child.name)
      if (next === undefined) {
        next = { tests: 0, next: undefined }
        entry.next.set(child.name, next)
      }
      if (child.type !== 'test') {
        visit(child, names, next)
        continue
      }
      child.fullName = names
      child.dupIndex = next.tests++
    }
  }
  visit(root, [], { tests: 0, next: undefined })
}

/**
 * Parses every node's and hook's captured site, then drops the hooks' sites. A location is its
 * site's first frame in the test file under `locationFrame: 'test-file'`, else its first frame.
 */
function parseLocations(
  root: SuiteNode,
  nodes: Nodes,
  testFile: string,
  inTestFile: boolean,
): void {
  const paths = new Map<string, string>()
  const inFile = inTestFile ? testFile : undefined
  const parseHooks = (suite: SuiteNode): void => {
    for (const hooks of Object.values(suite.hooks)) {
      for (const hook of hooks) {
        hook.location = parseSite(hook.site, inFile, paths)
        hook.site = null
      }
    }
  }
  parseHooks(root)
  for (const node of nodes) {
    node.location = parseSite(node.site, inFile, paths)
    if (node.type !== 'test') parseHooks(node)
  }
}

function matchesFilters(test: TestNode, options: FinalizeOptions): 'name-filter' | undefined {
  const { testNamePattern, testIds, policy } = options
  if (testNamePattern !== undefined) {
    testNamePattern.lastIndex = 0
    if (!testNamePattern.test(test.fullName.join(policy.nameSeparator))) return 'name-filter'
  }
  if (testIds !== undefined && !testIds.has(test.id)) return 'name-filter'
  return undefined
}

/** `focus.scope: 'file'`: jest-circus's mode inheritance and file-wide focus. */
function interpretFileScope(root: SuiteNode, options: FinalizeOptions): void {
  const { policy } = options
  const effective = new Map<SuiteNode | TestNode, RunMode | undefined>()
  let focused = false
  const define = (suite: SuiteNode, inherited: RunMode | undefined): void => {
    const own = suite.parent === null ? undefined : (suite.declared ?? inherited)
    effective.set(suite, own)
    const passMode = !(
      own === 'only' &&
      suite.children.some((child) => child.type === 'test' && child.declared === 'only')
    )
    for (const child of suite.children) {
      if (child.type !== 'test') {
        define(child, own)
        continue
      }
      const mode = child.declared ?? (passMode ? own : undefined)
      effective.set(child, mode)
      if (mode === 'only' && own !== 'skip') focused = true
    }
  }
  define(root, undefined)

  /** `ancestorReason`: why the nearest skipped ancestor is skipped, when one is. */
  const run = (suite: SuiteNode, ancestorReason: NodeSkipReason | undefined): void => {
    const own = effective.get(suite)
    const skipped =
      own === 'skip' || (policy.focus.insideSkip === 'skipped' && ancestorReason !== undefined)
    suite.mode = skipped ? 'skip' : 'run'
    // A suite skipped by its own modifier keeps that reason; one skipped with an ancestor (a
    // `describe.skipIf(true)` above it) takes the ancestor's, as its tests do.
    if (skipped) suite.skipReason = skipReasonFor(suite, ancestorReason)
    for (const child of suite.children) {
      if (child.type !== 'test') {
        run(child, skipped ? suite.skipReason : undefined)
        continue
      }
      const mode = effective.get(child)
      let reason: NodeSkipReason | undefined
      if (skipped || mode === 'skip') {
        reason = skipReasonFor(child, suite.skipReason)
      } else if (focused && mode === undefined) {
        reason = 'only-filter'
      } else {
        reason = matchesFilters(child, options)
      }
      if (reason === undefined) {
        child.mode = mode === 'todo' ? 'todo' : 'run'
      } else if (
        mode === 'todo' &&
        reason === 'modifier' &&
        policy.status.todoUnderSkip === 'todo'
      ) {
        child.mode = 'todo'
      } else {
        child.mode = 'skip'
        child.skipReason = reason
      }
    }
  }
  run(root, undefined)
}

/**
 * A skipped node's reason: its own (set at registration for its own `.skip` or `skipIf`), else the
 * skipped ancestor's.
 */
function skipReasonFor(
  node: SuiteNode | TestNode,
  ancestorReason: NodeSkipReason | undefined,
): NodeSkipReason {
  return node.skipReason ?? ancestorReason ?? 'modifier'
}

/** `focus.scope: 'suite'`: Vitest's `interpretTaskModes`. */
function interpretSuiteScope(root: SuiteNode, nodes: Nodes, options: FinalizeOptions): void {
  const { policy } = options
  const containsOnly = new Map<SuiteNode, boolean>()
  const scan = (suite: SuiteNode): boolean => {
    let found = false
    for (const child of suite.children) {
      if (child.declared === 'only') found = true
      if (child.type !== 'test' && scan(child)) found = true
    }
    containsOnly.set(suite, found)
    return found
  }
  const onlyMode = scan(root)
  for (const node of nodes) node.mode = node.declared ?? 'run'

  /** Skips (or todos) everything below `suite`; skipped tasks take the suite's reason. */
  const skipAll = (
    suite: SuiteNode,
    mode: 'skip' | 'todo',
    reason: NodeSkipReason = 'modifier',
  ): void => {
    for (const child of suite.children) {
      const keep =
        mode === 'skip' && policy.focus.insideSkip === 'runs' && child.declared === 'only'
      if (keep) {
        if (child.type !== 'test') traverse(child, true)
        else child.mode = 'run'
        continue
      }
      if (child.mode === 'run' || child.mode === 'only') {
        child.mode = mode
        if (mode === 'skip') child.skipReason ??= reason
      } else if (
        child.mode === 'todo' &&
        mode === 'skip' &&
        policy.status.todoUnderSkip === 'skipped'
      ) {
        child.mode = 'skip'
        child.skipReason ??= reason
      }
      // A child already skipped has its own `.skip` (or a `skip` option it inherited), and the
      // reason registration gave it.
      if (child.type !== 'test') skipAll(child, mode, reason)
    }
  }

  const traverse = (suite: SuiteNode, parentIsOnly: boolean): void => {
    const suiteIsOnly = parentIsOnly || suite.declared === 'only'
    const someOnly = onlyMode && containsOnly.get(suite) === true
    for (const child of suite.children) {
      const childContainsOnly = child.type !== 'test' && containsOnly.get(child) === true
      const include = someOnly
        ? child.mode === 'only' || childContainsOnly
        : suiteIsOnly || child.mode === 'only'
      if (onlyMode) {
        if (child.mode === 'run' && !(include || childContainsOnly)) {
          child.mode = 'skip'
          child.skipReason = 'only-filter'
        } else if (child.mode === 'only') {
          child.mode = 'run'
        }
      }
      if (child.type === 'test') {
        const reason = matchesFilters(child, options)
        if (reason !== undefined && child.mode !== 'skip') {
          child.mode = 'skip'
          child.skipReason = reason
        }
      } else if (child.mode === 'skip') {
        skipAll(child, 'skip', child.skipReason)
      } else if (child.mode === 'todo') {
        skipAll(child, 'todo')
      } else {
        traverse(child, include)
      }
    }
  }
  traverse(root, false)
}

/**
 * The location filter, as Vitest's `file:line` (`interpretTaskModes`): a task on one of the lines
 * runs, whatever focus made it, and so does everything under a matched suite; every other test is
 * skipped. Only locations in the test file count, and the walk never enters a skipped or todo
 * suite, so a line inside one is "not found".
 */
function applyLineFilter(file: FileState, testFile: string, options: FinalizeOptions): void {
  const { lines } = options
  if (lines === undefined || lines.size === 0) return
  const matched = new Set<number>()
  const visit = (suite: SuiteNode, inMatch: boolean): void => {
    for (const child of suite.children) {
      const line = child.location?.file === testFile ? child.location.line : undefined
      const hit = line !== undefined && lines.has(line)
      if (hit) matched.add(line)
      if (hit || inMatch) {
        runMatched(child, options)
      } else if (child.type === 'test' && child.mode !== 'skip') {
        child.mode = 'skip'
        child.skipReason = 'name-filter'
      }
      if (child.type !== 'test' && child.mode !== 'skip' && child.mode !== 'todo') {
        visit(child, inMatch || hit)
      }
    }
  }
  visit(file.root, false)
  const missing = [...lines].filter((line) => !matched.has(line))
  if (missing.length > 0) {
    const which = missing.length === 1 ? `line ${missing[0]}` : `lines ${missing.join(', ')}`
    file.errors.push(
      new CoreError('CORE_INVALID_ARGUMENT', `No test found in ${file.relativePath} in ${which}`),
    )
  }
}

/** A task the line filter selected runs, unless the name or id filters leave it out. */
function runMatched(node: SuiteNode | TestNode, options: FinalizeOptions): void {
  node.mode = 'run'
  node.skipReason = node.type === 'test' ? matchesFilters(node, options) : undefined
  if (node.skipReason !== undefined) node.mode = 'skip'
}

/**
 * `allowOnly: 'not-in-ci'` on CI: every `.only` task that would run fails before it runs. One in a
 * skipped or todo subtree is left alone: Vitest never walks there, so its check never fires.
 */
function blockOnly(nodes: Nodes, options: FinalizeOptions): void {
  if (options.policy.allowOnly === 'always' || !options.ci) return
  for (const node of nodes) {
    if (node.declared !== 'only' || node.mode === 'skip' || node.mode === 'todo') continue
    node.blocked = new CoreError(
      'CORE_ONLY_NOT_ALLOWED',
      'Unexpected .only modifier. Remove it or allow `.only` to bypass this error',
    )
  }
}

/** The suites with a test somewhere below them: each test marks its ancestors, once each. */
function suitesWithTests(nodes: Nodes): ReadonlySet<SuiteNode> {
  const found = new Set<SuiteNode>()
  for (const node of nodes) {
    if (node.type !== 'test') continue
    for (let suite: SuiteNode | null = node.parent; suite !== null && !found.has(suite); ) {
      found.add(suite)
      suite = suite.parent
    }
  }
  return found
}

/** `collect.emptyDescribe`: a describe with no tests. */
function checkEmpty(file: FileState, nodes: Nodes, policy: CorePolicy): void {
  const rule = policy.collect.emptyDescribe
  if (rule === 'allow') return
  const withTests = suitesWithTests(nodes)
  if (rule === 'fail-suite') {
    failEmptySuites(file.root, withTests)
    return
  }
  for (const node of nodes) {
    if (node.type === 'test' || withTests.has(node)) continue
    for (const kind of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const) {
      file.errors.push(
        ...node.hooks[kind].map(
          () =>
            new CoreError(
              'CORE_EMPTY_DESCRIBE',
              `Invalid: ${kind}() may not be used in a describe block containing no tests.`,
            ),
        ),
      )
    }
  }
}

/**
 * `fail-suite` (Vitest), children first: a running describe none of whose children runs collapses
 * to skip (`interpretTaskModes`), and a running describe with no test below it fails.
 */
function failEmptySuites(suite: SuiteNode, withTests: ReadonlySet<SuiteNode>): void {
  for (const child of suite.children) {
    if (child.type === 'test') continue
    failEmptySuites(child, withTests)
    if (child.mode !== 'run') continue
    if (child.children.length > 0 && child.children.every((node) => node.mode !== 'run')) {
      child.mode = 'skip'
    } else if (!withTests.has(child)) {
      child.emptyError = new CoreError(
        'CORE_EMPTY_DESCRIBE',
        `No test found in suite ${child.name}`,
      )
    }
  }
}

/** The clone-safe task list, file first; each node keeps its own task for the executor. */
function toTasks(
  file: FileState,
  nodes: Nodes,
  projectName: string,
  testTimeoutMs: number,
): TaskNode[] {
  const root = file.root
  const fileTask: FileTask = {
    type: 'file',
    id: root.id,
    parentId: null,
    fileId: root.id,
    name: file.relativePath,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    path: file.relativePath,
    projectName,
    children: root.children.map((child) => child.id),
  }
  root.task = fileTask
  const tasks: TaskNode[] = [fileTask]
  for (const node of nodes) {
    const base = {
      id: node.id,
      parentId: node.parent?.id ?? null,
      fileId: root.id,
      name: node.name,
      mode: node.declared ?? 'run',
      location: node.location ?? null,
    }
    if (node.type !== 'test') {
      const suite: SuiteTask = {
        ...base,
        type: 'suite',
        tags: node.options.tags,
        meta: node.options.meta,
        children: node.children.map((child) => child.id),
        each: node.each,
        concurrent: node.concurrent === true,
        shuffle: node.shuffle,
      }
      node.task = suite
      tasks.push(suite)
      continue
    }
    const test: TestTask = {
      ...base,
      type: 'test',
      tags: node.tags,
      meta: node.meta,
      fullName: node.fullName,
      dupIndex: node.dupIndex,
      each: node.each,
      concurrent: node.concurrent,
      expectFail: node.expectFail,
      timeoutMs: node.timeoutMs ?? testTimeoutMs,
      retry: node.retry,
      repeats: node.repeats,
    }
    node.task = test
    tasks.push(test)
  }
  return tasks
}
