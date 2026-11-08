import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { UserConsoleLog } from 'vitest'
import { parseSidecar } from '../sidecar.ts'
import VitestSidecarReporter, { type ReportedEntities } from './vitest.ts'

let dir = ''
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-vitest-sidecar-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Lookup = ReportedEntities['state']['getReportedEntityById']
type Entity = NonNullable<ReturnType<Lookup>>
type ModuleEntity = Extract<Entity, { type: 'module' }>
type SuiteEntity = Extract<Entity, { type: 'suite' }>
type TestEntity = Extract<Entity, { type: 'test' }>

/**
 * A module the way Vitest reports one: `/work/a.test.ts` with a top-level test, a suite with two
 * tests of the same name and a nested suite, in declaration order.
 */
function moduleTree(): { readonly entities: Map<string, Entity> } {
  const tests: TestEntity[] = []
  const module: ModuleEntity = {
    type: 'module',
    id: 'm',
    moduleId: '/work/a.test.ts',
    children: { allTests: () => tests },
  }
  const suite: SuiteEntity = { type: 'suite', name: 'group', module, parent: module }
  const nested: SuiteEntity = { type: 'suite', name: 'inner', module, parent: suite }
  const test = (id: string, name: string, parent: SuiteEntity | ModuleEntity): TestEntity => {
    const entity: TestEntity = { type: 'test', id, name, module, parent }
    tests.push(entity)
    return entity
  }
  const entities = new Map<string, Entity>([
    ['m', module],
    ['s', suite],
    ['t0', test('t0', 'top', module)],
    ['t1', test('t1', 'same', suite)],
    ['t2', test('t2', 'same', suite)],
    ['t3', test('t3', 'deep', nested)],
  ])
  return { entities }
}

function log(
  taskId: string | undefined,
  type: 'stdout' | 'stderr',
  content: string,
): UserConsoleLog {
  return {
    ...(taskId === undefined ? {} : { taskId }),
    type,
    content,
    time: 0,
    size: content.length,
  }
}

test('a write in a test names the test by title path and dupIndex; others name the file', async () => {
  const outputFile = path.join(dir, 'attribution.jsonl')
  const { entities } = moduleTree()
  const reporter = new VitestSidecarReporter({ outputFile })
  reporter.onInit({ state: { getReportedEntityById: (id) => entities.get(id) } })
  reporter.onUserConsoleLog(log('t0', 'stdout', 'top\n'))
  reporter.onUserConsoleLog(log('t2', 'stderr', 'second same\nand more\n'))
  reporter.onUserConsoleLog(log('t1', 'stdout', 'first same\n'))
  reporter.onUserConsoleLog(log('t3', 'stdout', 'deep\n'))
  reporter.onUserConsoleLog(log('s', 'stdout', 'beforeAll of group\n'))
  reporter.onUserConsoleLog(log('m', 'stdout', 'module top level\n'))
  reporter.onUserConsoleLog(log(undefined, 'stdout', 'outside any task\n'))
  reporter.onUserConsoleLog(log('gone', 'stdout', 'an id Vitest no longer knows\n'))
  const file = '/work/a.test.ts'
  assert.deepEqual(parseSidecar(await readFile(outputFile, 'utf8')), [
    { file, test: { path: ['top'], dupIndex: 0 }, stream: 'stdout', text: 'top\n' },
    {
      file,
      test: { path: ['group', 'same'], dupIndex: 1 },
      stream: 'stderr',
      text: 'second same\nand more\n',
    },
    {
      file,
      test: { path: ['group', 'same'], dupIndex: 0 },
      stream: 'stdout',
      text: 'first same\n',
    },
    {
      file,
      test: { path: ['group', 'inner', 'deep'], dupIndex: 0 },
      stream: 'stdout',
      text: 'deep\n',
    },
    { file, stream: 'stdout', text: 'beforeAll of group\n' },
    { file, stream: 'stdout', text: 'module top level\n' },
    { stream: 'stdout', text: 'outside any task\n' },
    { stream: 'stdout', text: 'an id Vitest no longer knows\n' },
  ])
})

test('a write before onInit, or a run that printed nothing, still leaves a well-formed file', async () => {
  const outputFile = path.join(dir, 'early.jsonl')
  const reporter = new VitestSidecarReporter({ outputFile })
  assert.equal(await readFile(outputFile, 'utf8'), '')
  reporter.onUserConsoleLog(log('t0', 'stdout', 'early\n'))
  assert.deepEqual(parseSidecar(await readFile(outputFile, 'utf8')), [
    { stream: 'stdout', text: 'early\n' },
  ])
})
