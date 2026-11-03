// Track 5 §Types → "Type tests that must pass in CI": the 8 groups, plus the fields the one event
// model adds for Track 12 (build-plan §6).
import type {
  CloneSafe,
  DefinitionBuilder,
  EachApi,
  RuntimeEvent,
  RuntimeEventOf,
  SkipReason,
  TaskId,
  TaskNode,
  TaskResult,
  TestContext,
  TestTask,
  VisibleFrom,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare function assertNever(value: never): never
type DefsOf<B> = B extends DefinitionBuilder<infer D> ? D : never

declare const root: DefinitionBuilder<Record<never, never>>

// 1. Chained `define` infers each value and the composed object, with no annotations.
const withPort = root.define('port', {}, () => 3000)
expectTypeOf<VisibleFrom<DefsOf<typeof withPort>, 'test'>>().toEqualTypeOf<{
  readonly port: number
}>()
const withUrl = withPort.define('url', {}, ({ port }) => `http://localhost:${port}`)
const composed = withUrl.define('server', {}, async ({ port, url }) => ({ port, url }))
expectTypeOf<VisibleFrom<DefsOf<typeof composed>, 'test'>>().toEqualTypeOf<{
  readonly port: number
  readonly url: string
  readonly server: { port: number; url: string }
}>()

// 2. Scopes: a factory sees only keys that live at least as long as it does.
const scoped = root
  .define('db', { scope: 'worker' }, () => ({ query: (sql: string) => sql }))
  .define('dir', { scope: 'file' }, () => '/tmp/x')
  .define('user', {}, () => ({ id: 1 }))
scoped.define('fileValue', { scope: 'file' }, ({ db, dir }) => db.query(dir))
// @ts-expect-error a worker factory can't read a file key
scoped.define('workerValue', { scope: 'worker' }, ({ dir }) => dir)
// @ts-expect-error a file factory can't read a test key
scoped.define('fileUser', { scope: 'file' }, ({ user }) => user)

// 3. Re-defining is an error; `override` keeps the key's type, and `parent()` is typed.
// @ts-expect-error define of an existing key
scoped.define('user', {}, () => 1)
// @ts-expect-error override with a different value type
scoped.override('user', () => 'admin')
// @ts-expect-error override of an unknown key
scoped.override('nope', () => 1)
scoped.override('user', async (_deps, { parent }) => {
  expectTypeOf(parent).returns.toEqualTypeOf<Promise<{ id: number }>>()
  return { id: (await parent()).id + 1 }
})

// 4. `.each` spreads tuple rows and passes object rows whole; `.for` passes (row, ctx).
declare const api: EachApi<TestContext>
api.each([
  [1, 'a'],
  [2, 'b'],
] as const)('row %d', (n, s) => {
  expectTypeOf(n).toEqualTypeOf<1 | 2>()
  expectTypeOf(s).toEqualTypeOf<'a' | 'b'>()
})
api.each([{ a: 1 }, { a: 2 }])('row $a', (row) => {
  expectTypeOf(row.a).toEqualTypeOf<1 | 2>()
})
// @ts-expect-error an object row is one argument
api.each([{ a: 1 }])('row', (row, extra: number) => [row, extra])
api.for([1, 2])('row %d', (row, ctx) => {
  expectTypeOf(row).toEqualTypeOf<1 | 2>()
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
})

// 5. The tree and the events cross threads: no function-typed field at any depth.
expectTypeOf<RuntimeEvent>().toExtend<CloneSafe<RuntimeEvent>>()
expectTypeOf<TaskNode>().toExtend<CloneSafe<TaskNode>>()
expectTypeOf<TestContext>().not.toExtend<CloneSafe<TestContext>>()

// 6. An exhaustive switch over the event union compiles.
export function describeEvent(event: RuntimeEvent): string {
  switch (event.type) {
    case 'file-collect-start':
    case 'file-collect-end':
    case 'file-end':
      return event.fileId
    case 'suite-start':
    case 'suite-end':
    case 'test-start':
    case 'test-attempt-start':
    case 'test-attempt-end':
    case 'test-end':
      return event.id
    case 'hook-start':
    case 'hook-end':
      return `${event.kind}#${event.ordinal}`
    case 'annotation':
      return event.testId
    case 'console':
      return event.text
    case 'unhandled-error':
      return event.origin
    default:
      return assertNever(event)
  }
}

// 7. A task id is branded.
// @ts-expect-error a plain string is not a TaskId
const id: TaskId = 'file::test'

// 8. `skip(note)` ends the test; `skip(condition, note)` may not.
declare const ctx: TestContext
expectTypeOf(ctx.skip('x')).toEqualTypeOf<never>()
expectTypeOf(ctx.skip(false, 'x')).toEqualTypeOf<void>()

// The one event model carries what Track 12 needs (build-plan §6).
expectTypeOf<RuntimeEventOf<'hook-start'>['ownerId']>().toEqualTypeOf<TaskId>()
expectTypeOf<RuntimeEventOf<'hook-start'>['ordinal']>().toEqualTypeOf<number>()
expectTypeOf<RuntimeEventOf<'hook-end'>['ordinal']>().toEqualTypeOf<number>()
expectTypeOf<TestTask['fullName']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<TestTask['dupIndex']>().toEqualTypeOf<number>()
expectTypeOf<TaskResult['passingAssertions']>().toEqualTypeOf<number>()
expectTypeOf<TaskResult['skipReason']>().toEqualTypeOf<SkipReason | undefined>()
expectTypeOf<RuntimeEventOf<'console'>['taskId']>().toEqualTypeOf<TaskId | null>()
expectTypeOf<RuntimeEventOf<'test-end'>['result']>().toEqualTypeOf<TaskResult>()
// @ts-expect-error skipReason is optional, not undefined (exactOptionalPropertyTypes)
const skipped: Pick<TaskResult, 'skipReason'> = { skipReason: undefined }

export { id, skipped }
