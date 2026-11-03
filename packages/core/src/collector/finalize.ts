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
import type { FileState, SuiteNode, TestNode } from '../internal/model.ts'
import { parseSite } from './location.ts'

/** Filters and settings that shape a collected file. */
export interface FinalizeOptions {
  readonly policy: CorePolicy
  readonly projectName: string
  readonly ci: boolean
  readonly testNamePattern: RegExp | undefined
  readonly testIds: ReadonlySet<string> | undefined
  /** Location filter: lines of tests or suites to run (Vitest's `file:line`). */
  readonly lines: ReadonlySet<number> | undefined
}

/** Assigns ids and full names, interprets modes, and returns the file's task list. */
export function finalize(file: FileState, options: FinalizeOptions): TaskNode[] {
  assignIds(file, options.projectName)
  assignNames(file.root, [])
  parseLocations(file.root)
  if (options.policy.focus.scope === 'file') interpretFileScope(file.root, options)
  else interpretSuiteScope(file.root, options)
  applyLineFilter(file, options.lines)
  blockOnly(file.root, options)
  checkEmpty(file, options.policy)
  return toTasks(file, options.projectName)
}

/** A file's task id: a hash of the project name and its relative path (stable across runs). */
export function fileIdOf(projectName: string, relativePath: string): TaskId {
  return hash('sha1', `${projectName}\0${relativePath}`).slice(0, 10) as TaskId
}

function assignIds(file: FileState, projectName: string): void {
  file.root.id = fileIdOf(projectName, file.relativePath)
  const visit = (suite: SuiteNode): void => {
    suite.children.forEach((child, index) => {
      child.id = `${suite.id}_${index}` as TaskId
      if (child.type !== 'test') visit(child)
    })
  }
  visit(file.root)
}

function assignNames(suite: SuiteNode, path: readonly string[]): void {
  const counts = new Map<string, number>()
  const visit = (node: SuiteNode, prefix: readonly string[]): void => {
    for (const child of node.children) {
      const names = [...prefix, child.name]
      if (child.type !== 'test') {
        visit(child, names)
        continue
      }
      const key = JSON.stringify(names)
      const seen = counts.get(key) ?? 0
      counts.set(key, seen + 1)
      child.fullName = names
      child.dupIndex = seen
    }
  }
  visit(suite, path)
}

function parseLocations(suite: SuiteNode): void {
  for (const child of suite.children) {
    child.location = parseSite(child.site)
    if (child.type !== 'test') parseLocations(child)
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

  const run = (suite: SuiteNode, ancestorSkipped: boolean): void => {
    const own = effective.get(suite)
    const skipped = own === 'skip' || (policy.focus.insideSkip === 'skipped' && ancestorSkipped)
    suite.mode = skipped ? 'skip' : 'run'
    if (skipped && suite.skipReason === undefined) suite.skipReason = 'modifier'
    for (const child of suite.children) {
      if (child.type !== 'test') {
        run(child, skipped)
        continue
      }
      const mode = effective.get(child)
      let reason: TestNode['skipReason']
      if (skipped || mode === 'skip') reason = child.skipReason ?? 'modifier'
      else if (focused && mode === undefined) reason = 'only-filter'
      else reason = matchesFilters(child, options)
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
  run(root, false)
}

/** `focus.scope: 'suite'`: Vitest's `interpretTaskModes`. */
function interpretSuiteScope(root: SuiteNode, options: FinalizeOptions): void {
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
  for (const node of walk(root)) node.mode = node.declared ?? 'run'

  /** Skips (or todos) everything below `suite`; skipped tasks take the suite's reason. */
  const skipAll = (
    suite: SuiteNode,
    mode: 'skip' | 'todo',
    reason: NonNullable<TestNode['skipReason']> = 'modifier',
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
        if (child.type !== 'test' && (include || childContainsOnly)) {
          if (child.mode === 'only') child.mode = 'run'
        } else if (child.mode === 'run' && !include) {
          child.mode = 'skip'
          child.skipReason = 'only-filter'
        } else if (child.mode === 'only') {
          child.mode = 'run'
        }
      }
      if (child.type === 'test') {
        if (child.mode === 'skip') child.skipReason ??= 'modifier'
        const reason = matchesFilters(child, options)
        if (reason !== undefined && child.mode !== 'skip') {
          child.mode = 'skip'
          child.skipReason = reason
        }
      } else if (child.mode === 'skip') {
        child.skipReason ??= 'modifier'
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

/** The location filter: tests (or suites) on the given lines run; the rest are skipped. */
function applyLineFilter(file: FileState, lines: ReadonlySet<number> | undefined): void {
  if (lines === undefined || lines.size === 0) return
  const matched = new Set<number>()
  const visit = (suite: SuiteNode, inMatch: boolean): void => {
    for (const child of suite.children) {
      const line = child.location?.line
      const hit = line !== undefined && lines.has(line)
      if (hit && line !== undefined) matched.add(line)
      if (child.type !== 'test') visit(child, inMatch || hit)
      else if (!(inMatch || hit) && child.mode === 'run') {
        child.mode = 'skip'
        child.skipReason = 'name-filter'
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

/** `allowOnly: 'not-in-ci'` on CI: every `.only` task fails before it runs. */
function blockOnly(root: SuiteNode, options: FinalizeOptions): void {
  if (options.policy.allowOnly === 'always' || !options.ci) return
  for (const node of walk(root)) {
    if (node.declared !== 'only') continue
    node.blocked = new CoreError(
      'CORE_ONLY_NOT_ALLOWED',
      'Unexpected .only modifier. Remove it or allow `.only` to bypass this error',
    )
  }
}

function hasTests(suite: SuiteNode): boolean {
  return suite.children.some((child) => child.type === 'test' || hasTests(child))
}

/** `collect.emptyDescribe`: a describe with no tests. */
function checkEmpty(file: FileState, policy: CorePolicy): void {
  const rule = policy.collect.emptyDescribe
  if (rule === 'allow') return
  for (const node of walk(file.root)) {
    if (node.type === 'test' || hasTests(node)) continue
    if (rule === 'fail-suite') {
      if (node.mode === 'run') {
        node.emptyError = new CoreError(
          'CORE_EMPTY_DESCRIBE',
          `No test found in suite ${node.name}`,
        )
      }
      continue
    }
    for (const kind of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const) {
      for (const _hook of node.hooks[kind]) {
        file.errors.push(
          new CoreError(
            'CORE_EMPTY_DESCRIBE',
            `Invalid: ${kind}() may not be used in a describe block containing no tests.`,
          ),
        )
      }
    }
  }
}

/** Every node below `suite`, depth first, parents before children. */
export function* walk(suite: SuiteNode): Generator<SuiteNode | TestNode> {
  for (const child of suite.children) {
    yield child
    if (child.type !== 'test') yield* walk(child)
  }
}

function toTasks(file: FileState, projectName: string): TaskNode[] {
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
  const tasks: TaskNode[] = [fileTask]
  for (const node of walk(root)) {
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
      timeoutMs: node.timeoutMs,
      retry: node.retry,
      repeats: node.repeats,
    }
    tasks.push(test)
  }
  return tasks
}
