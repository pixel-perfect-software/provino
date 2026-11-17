import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildFile,
  error,
  type FileSpec,
  resultOf,
  type TestSpec,
} from '../../internal/test-support.ts'
import { createRunState, type FinishedFile } from './state.ts'
import {
  createTreeStore,
  MAX_TREE_FAILURES,
  MAX_TREE_SUITES,
  type TreeFile,
  type TreeStore,
} from './tree-store.ts'

/** Plays one file through the state and the store as the reporter's handlers do, and compacts it. */
function play(spec: FileSpec, store: TreeStore = createTreeStore()) {
  const built = buildFile(spec)
  const state = createRunState()
  state.start([built.info], 0)
  state.fileStart(built.info, 0, 1)
  store.collected(built.info.fileId, built.tasks)
  for (const { task, spec: test } of built.tests) {
    if (test.ran === false) continue
    const result = resultOf(test)
    const [first] = result.errors
    state.testEnd(
      built.info.fileId,
      result.state,
      result.state === 'fail'
        ? { title: task.fullName, location: null, errors: result.errors }
        : undefined,
    )
    store.testEnd(built.info.fileId, task.id, result.state, result.durationMs, first)
  }
  for (const { task, errors } of built.suiteEnds) {
    store.suiteFailed(built.info.fileId, task.id, errors[0])
  }
  state.fileEnd(built.result)
  const finished = state.take()[0] as FinishedFile
  return { store, built, finished }
}

function tests(...specs: readonly TestSpec[]): readonly TestSpec[] {
  return specs
}

describe('a file that fully passed', () => {
  test('keeps its numbers only, and its record is released', () => {
    const { store, finished } = play({
      path: 'src/a.test.ts',
      durationMs: 42,
      tests: tests(
        { path: ['a', 'one'], durationMs: 3 },
        { path: ['a', 'two'], state: 'skip', skipReason: 'modifier' },
        { path: ['three'], state: 'todo' },
      ),
    })
    assert.equal(store.held(), 1)
    const file = store.compact(finished)
    assert.equal(store.held(), 0)
    assert.deepEqual(file, {
      path: 'src/a.test.ts',
      project: '',
      kind: 'pass',
      tests: 3,
      failed: 0,
      skipped: 2,
      durationMs: 42,
    })
    assert.equal(file.open, undefined)
  })

  test('a file of only todo tests is a todo file; a skipped file is skipped', () => {
    const todo = play({ path: 'a.test.ts', tests: tests({ path: ['x'], state: 'todo' }) })
    assert.equal(todo.store.compact(todo.finished).kind, 'todo')
    const skipped = play({
      path: 'b.test.ts',
      state: 'skip',
      tests: tests({ path: ['x'], state: 'skip' }),
    })
    assert.equal(skipped.store.compact(skipped.finished).kind, 'skip')
  })

  test('the file takes the run path and the project of its result', () => {
    const { store, built, finished } = play({ path: 'a.test.ts', project: 'web' })
    assert.equal(built.info.project, 'web')
    const file = store.compact(finished)
    assert.equal(file.project, 'web')
    assert.equal(file.path, 'a.test.ts')
  })
})

describe('a file with a failure', () => {
  const failing = (): FileSpec => ({
    path: 'src/cart.test.ts',
    durationMs: 100,
    tests: tests(
      { path: ['cart', 'total', 'sums'], durationMs: 2 },
      {
        path: ['cart', 'total', 'discounts'],
        state: 'fail',
        durationMs: 5,
        errors: [error('expected 90\n\nReceived: 100', { name: 'AssertionError' })],
      },
      { path: ['cart', 'total', 'rounds'], durationMs: 1 },
      { path: ['cart', 'empty', 'is zero'], durationMs: 4 },
      { path: ['cart', 'tax', 'later'], state: 'todo' },
      { path: ['cart', 'tax', 'skipped'], state: 'skip', skipReason: 'modifier' },
      { path: ['cart', 'adds'], durationMs: 2 },
      { path: ['loose'], state: 'skip', skipReason: 'modifier' },
    ),
  })

  test('opens down to the failed test, with the first line of its error and its name', () => {
    const { store, finished } = play(failing())
    const file = store.compact(finished)
    assert.equal(file.kind, 'fail')
    assert.equal(file.failed, 1)
    const open = (file as TreeFile).open
    assert.ok(open)
    // The file's own tests that are not listed: the skipped one.
    assert.deepEqual(open.rest, { passed: 0, skipped: 1, todo: 0, durationMs: 1 })
    assert.equal(open.moreFailed, 0)
    assert.deepEqual(open.messages, [])
    const [cart] = open.children
    assert.equal(cart?.name, 'cart')
    assert.equal(cart?.state, 'fail')
    assert.equal(cart?.tests, 7)
    assert.equal(cart?.failed, 1)
    assert.equal(cart?.skipped, 2)
    // The sum of its tests' times, not a clock (a test with no time of its own took 1 ms).
    assert.equal(cart?.durationMs, 2 + 5 + 1 + 4 + 1 + 1 + 2)
    const [total, empty, tax] = cart?.children ?? []
    assert.equal(total?.name, 'total')
    assert.equal(total?.state, 'fail')
    // Declaration order: the failed test, and the passing two counted in the rest.
    const [discounts] = total?.children ?? []
    assert.equal(discounts?.kind, 'test')
    assert.equal(discounts?.name, 'discounts')
    assert.equal(discounts?.message, 'AssertionError: expected 90')
    assert.equal(discounts?.durationMs, 5)
    assert.deepEqual(total?.rest, { passed: 2, skipped: 0, todo: 0, durationMs: 3 })
    // A suite with no failure is one folded row: its counts, and nothing below it.
    assert.equal(empty?.name, 'empty')
    assert.equal(empty?.state, 'pass')
    assert.equal(empty?.tests, 1)
    assert.deepEqual(empty?.children, [])
    assert.equal(empty?.rest, undefined)
    assert.equal(tax?.state, 'skip')
    assert.equal(tax?.tests, 2)
    assert.equal(tax?.skipped, 2)
    // cart's own test that is not listed.
    assert.deepEqual(cart?.rest, { passed: 1, skipped: 0, todo: 0, durationMs: 2 })
    assert.equal(store.held(), 0)
  })

  test('a suite of only todo tests is todo', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: tests(
        { path: ['s', 'a'], state: 'todo' },
        { path: ['t', 'b'], state: 'fail', errors: [error('boom')] },
      ),
    })
    const open = store.compact(finished).open
    assert.equal(open?.children[0]?.name, 's')
    assert.equal(open?.children[0]?.state, 'todo')
    // No name prefix for a plain `Error`.
    assert.equal(open?.children[1]?.children[0]?.message, 'boom')
  })

  test('an error whose message already names it, or has no message, reads as itself', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: tests(
        {
          path: ['one'],
          state: 'fail',
          errors: [error('TypeError: x is not a function', { name: 'TypeError' })],
        },
        { path: ['two'], state: 'fail', errors: [error('', { name: 'RangeError' })] },
        { path: ['three'], state: 'fail', errors: [] },
      ),
    })
    const messages = store.compact(finished).open?.children.map((node) => node.message)
    assert.deepEqual(messages, ['TypeError: x is not a function', 'RangeError', undefined])
  })

  test('at most MAX_TREE_FAILURES failed tests are listed; the rest are counted', () => {
    const many: TestSpec[] = Array.from({ length: MAX_TREE_FAILURES + 7 }, (_, index) => ({
      path: ['group', `fails ${index}`],
      state: 'fail' as const,
      errors: [error(`failure ${index}`)],
    }))
    const { store, finished } = play({ path: 'a.test.ts', tests: many })
    const open = store.compact(finished).open
    const group = open?.children[0]
    assert.equal(group?.failed, MAX_TREE_FAILURES + 7, 'the suite still counts every failure')
    assert.equal(group?.children.length, MAX_TREE_FAILURES)
    assert.equal(group?.children[0]?.message, 'failure 0')
    assert.equal(open?.moreFailed, 7)
  })

  test('a test that never ended is counted nowhere', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      state: 'fail',
      tests: tests({ path: ['s', 'ran'] }, { path: ['s', 'never'], ran: false }),
      errors: [error('worker died')],
    })
    const open = store.compact(finished).open
    assert.equal(open?.children[0]?.tests, 1)
    assert.deepEqual(open?.messages, ['worker died'])
  })
})

describe('a suite whose own hook threw', () => {
  const nested = (state?: 'pass'): FileSpec => ({
    path: 'a.test.ts',
    ...(state === undefined ? {} : { state }),
    tests: tests(
      { path: ['outer', 'inner', 'passes'] },
      { path: ['outer', 'other', 'also passes'] },
      { path: ['outer', 'direct'] },
      { path: ['alone'] },
    ),
    suiteErrors: [
      { path: ['outer', 'inner'], errors: [error('afterAll broke', { name: 'HookError' })] },
    ],
  })

  test('is a failure for every suite above it: the tree opens down to it, though every test passed', () => {
    const { store, finished } = play(nested())
    const file = store.compact(finished)
    assert.equal(file.kind, 'fail')
    const [outer] = file.open?.children ?? []
    assert.equal(outer?.name, 'outer')
    assert.equal(outer?.state, 'fail', 'the parent is not folded into one passing row')
    assert.equal(outer?.failed, 0, 'no test of it failed: the count is of tests')
    const [inner, other] = outer?.children ?? []
    assert.equal(inner?.name, 'inner')
    assert.equal(inner?.state, 'fail')
    assert.equal(inner?.message, 'HookError: afterAll broke')
    // A sibling with nothing wrong is still one folded row; the parent's own test is counted in its rest.
    assert.equal(other?.state, 'pass')
    assert.deepEqual(other?.children, [])
    assert.equal(outer?.rest?.passed, 1)
  })

  test('opens the file even when the file’s own state says it passed', () => {
    const { store, finished } = play(nested('pass'))
    const file = store.compact(finished)
    // The orchestrator's word on the file stands; the tree still shows what the suite threw.
    assert.equal(file.kind, 'pass')
    assert.notEqual(file.open, undefined, 'not taken as a fully passed file')
    assert.equal(file.open?.children[0]?.children[0]?.message, 'HookError: afterAll broke')
  })

  test('a suite that failed three levels down opens all three', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: tests({ path: ['a', 'b', 'c', 'passes'] }),
      suiteErrors: [{ path: ['a', 'b', 'c'], errors: [error('boom')] }],
    })
    const a = store.compact(finished).open?.children[0]
    assert.deepEqual(
      [a?.state, a?.children[0]?.state, a?.children[0]?.children[0]?.state],
      ['fail', 'fail', 'fail'],
    )
  })
})

describe('what the store keeps is bounded', () => {
  test('a file holds only as many errors as it will list: the failures past the cap lose theirs', () => {
    const built = buildFile({
      path: 'a.test.ts',
      tests: Array.from({ length: MAX_TREE_FAILURES + 10 }, (_, index) => ({
        path: ['group', `fails ${index}`],
        state: 'fail' as const,
        errors: [error(`failure ${index}`)],
      })),
    })
    const store = createTreeStore()
    store.collected(built.info.fileId, built.tasks)
    // The tests end in reverse (a concurrent group, a shuffle): the first MAX_TREE_FAILURES to end
    // keep their errors, and those are not the first ten declared.
    for (const { task } of built.tests.toReversed()) {
      const index = Number(task.name.replace('fails ', ''))
      store.testEnd(built.info.fileId, task.id, 'fail', 1, error(`failure ${index}`))
    }
    const state = createRunState()
    state.start([built.info], 0)
    state.fileStart(built.info, 0, 1)
    for (const _ of built.tests) state.testEnd(built.info.fileId, 'fail')
    const group = store.compact(state.fileEnd(built.result)).open?.children[0]
    const listed = group?.children ?? []
    assert.equal(listed.length, MAX_TREE_FAILURES)
    assert.deepEqual(
      listed.slice(0, 10).map((node) => node.message),
      Array(10).fill(undefined),
      'declared first, ended last: no error was held for them',
    )
    assert.equal(listed[10]?.message, 'failure 10')
    assert.equal(listed.at(-1)?.message, `failure ${MAX_TREE_FAILURES - 1}`)
  })

  test('at most MAX_TREE_SUITES suites are listed under one level; the rest are counted, with their tests', () => {
    const count = MAX_TREE_SUITES + 10
    const specs: TestSpec[] = [
      ...Array.from({ length: count }, (_, index) => ({ path: [`suite ${index}`, 'passes'] })),
      { path: ['suite 0', 'fails'], state: 'fail' as const, errors: [error('boom')] },
      // In a suite that is not listed: counted into the file's `moreFailed`, listed nowhere.
      {
        path: [`suite ${count - 1}`, 'fails too'],
        state: 'fail' as const,
        errors: [error('bang')],
      },
    ]
    const { store, finished } = play({ path: 'a.test.ts', tests: specs })
    const file = store.compact(finished)
    const open = file.open
    assert.equal(open?.children.length, MAX_TREE_SUITES)
    assert.equal(open?.moreSuites, 10)
    assert.equal(open?.children[0]?.state, 'fail')
    assert.equal(open?.children[0]?.children[0]?.name, 'fails')
    assert.equal(open?.moreFailed, 1)
    // The file's counts are the run's, whatever was listed.
    assert.equal(file.tests, count + 2)
    assert.equal(file.failed, 2)
  })

  test('the suite cap holds at every level', () => {
    const specs: TestSpec[] = Array.from({ length: MAX_TREE_SUITES + 3 }, (_, index) => ({
      path: ['outer', `inner ${index}`, 'passes'],
    }))
    specs.push({ path: ['outer', 'inner 0', 'fails'], state: 'fail', errors: [error('boom')] })
    const { store, finished } = play({ path: 'a.test.ts', tests: specs })
    const file = store.compact(finished)
    const outer = file.open?.children[0]
    assert.equal(outer?.children.length, MAX_TREE_SUITES)
    assert.equal(outer?.moreSuites, 3)
    assert.equal(file.open?.moreSuites, 0, 'the file itself has one suite')
  })

  test('only the first MAX_TREE_SUITES suites that failed on their own keep their error', () => {
    const count = MAX_TREE_SUITES + 5
    const specs: TestSpec[] = Array.from({ length: count }, (_, index) => ({
      path: [`suite ${index}`, 'passes'],
    }))
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: specs,
      suiteErrors: Array.from({ length: count }, (_, index) => ({
        path: [`suite ${index}`],
        errors: [error(`hook ${index}`)],
      })),
    })
    const open = store.compact(finished).open
    // Every suite failed; the listed ones are the first MAX_TREE_SUITES, each with its error.
    assert.equal(open?.children.length, MAX_TREE_SUITES)
    assert.equal(open?.children[0]?.message, 'hook 0')
    assert.equal(open?.moreSuites, 5)
  })
})

describe('a suite that holds only todo tests below it', () => {
  test('is todo, as the file that holds the same is: the one rule, over everything below', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: tests(
        { path: ['outer', 'inner', 'later'], state: 'todo' },
        { path: ['outer', 'inner', 'also later'], state: 'todo' },
        { path: ['other', 'fails'], state: 'fail', errors: [error('boom')] },
      ),
    })
    const [outer] = store.compact(finished).open?.children ?? []
    assert.equal(outer?.name, 'outer')
    assert.equal(outer?.state, 'todo', 'only a nested todo suite below it')
    assert.equal(outer?.todo, 2)
    assert.equal(outer?.skipped, 2)
    const todoFile = play({
      path: 'b.test.ts',
      tests: tests({ path: ['x', 'y'], state: 'todo' }),
    })
    assert.equal(todoFile.store.compact(todoFile.finished).kind, 'todo')
  })

  test('is skipped when some of what is below it is skipped, not todo', () => {
    const { store, finished } = play({
      path: 'a.test.ts',
      tests: tests(
        { path: ['outer', 'inner', 'later'], state: 'todo' },
        { path: ['outer', 'inner', 'off'], state: 'skip', skipReason: 'modifier' },
        { path: ['other', 'fails'], state: 'fail', errors: [error('boom')] },
      ),
    })
    assert.equal(store.compact(finished).open?.children[0]?.state, 'skip')
  })
})

describe('a file that failed to run', () => {
  test('has its own errors and no tree when nothing was collected', () => {
    const store = createTreeStore()
    const built = buildFile({
      path: 'broken.test.ts',
      state: 'fail',
      errors: [
        error("Cannot find module './x'", { name: 'ImportError' }),
        error('second'),
        error('third'),
        error('fourth'),
      ],
    })
    const state = createRunState()
    state.start([built.info], 0)
    state.fileStart(built.info, 0, 1)
    state.fileEnd(built.result)
    const file = store.compact(state.take()[0] as FinishedFile)
    assert.equal(file.kind, 'fail')
    assert.deepEqual(file.open, {
      children: [],
      rest: undefined,
      messages: ["ImportError: Cannot find module './x'", 'second', 'third'],
      moreSuites: 0,
      moreFailed: 0,
    })
  })
})

describe('the store', () => {
  test('ignores a test of a file it holds no record of, and one that has not ended', () => {
    const store = createTreeStore()
    const built = buildFile({ path: 'a.test.ts', tests: tests({ path: ['x'] }) })
    const [first] = built.tests
    assert.ok(first)
    store.testEnd(built.info.fileId, first.task.id, 'pass', 1)
    assert.equal(store.held(), 0, 'no record is made by a test')
    store.collected(built.info.fileId, built.tasks)
    store.testEnd(built.info.fileId, first.task.id, 'running', 1)
    store.testEnd(built.info.fileId, first.task.id, 'queued', 1)
    const state = createRunState()
    state.start([built.info], 0)
    state.fileStart(built.info, 0, 1)
    state.fileEnd(built.result)
    const file = store.compact(state.take()[0] as FinishedFile)
    assert.equal(file.open, undefined)
    // After the compaction a late event makes no record.
    store.testEnd(built.info.fileId, first.task.id, 'fail', 1)
    assert.equal(store.held(), 0)
  })

  test('clear releases every record', () => {
    const store = createTreeStore()
    for (const path of ['a.test.ts', 'b.test.ts']) {
      const built = buildFile({ path })
      store.collected(built.info.fileId, built.tasks)
    }
    assert.equal(store.held(), 2)
    store.clear()
    assert.equal(store.held(), 0)
  })
})
