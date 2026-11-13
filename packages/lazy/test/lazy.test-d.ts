// The public types of @provino/lazy (T6.2). Every `@ts-expect-error` line names the error code and a
// substring of the message it must produce: `test/type-errors.test.ts` removes each directive, compiles
// with TS 7.0.2 and 5.9.3, and asserts that the next line fails with exactly that code and text, so a
// directive can never hide a different error. The rows follow Track 6's type-test table.
import {
  type CheckKey,
  includeContext,
  includeExamples,
  itBehavesLike,
  type Lazy,
  lazy,
  type ReservedKey,
  type SharedLazy,
  sharedContext,
  sharedExamples,
  type TaskInfo,
  type Values,
} from '@provino/lazy'
import { expectTypeOf } from 'expect-type'

interface User {
  readonly name: string
}
interface Admin extends User {
  readonly admin: true
}
interface Cart {
  readonly items: readonly string[]
}
interface Db {
  readonly query: (sql: string) => string
}
interface Repo {
  readonly find: (id: number) => User
}
interface Stack {
  readonly size: number
  push(value: number): void
}

declare const ada: User
declare const admin: Admin
declare const db: Db
declare const repo: Repo
declare const stack: Stack
declare const testCtx: { readonly task: object }

// Chained inference
const $ = lazy
  .let('user', (): User => ada)
  .let('cart', ({ user }): Cart => {
    expectTypeOf(user).toEqualTypeOf<User>()
    return { items: [user.name] }
  })
expectTypeOf($.user).toEqualTypeOf<User>()
expectTypeOf($.cart).toEqualTypeOf<Cart>()
expectTypeOf($).toExtend<Lazy<{ user: User } & { cart: Cart }>>()
// @ts-expect-error TS2339 Property 'nope' does not exist
$.nope
// @ts-expect-error TS2540 Cannot assign to 'user' because it is a read-only property
$.user = ada
// @ts-expect-error TS2339 Property 'later' does not exist
lazy.let('early', ({ later }) => later).let('later', () => 1)
// @ts-expect-error TS2345 'then' is reserved and cannot be a lazy key
lazy.let('then', () => 1)

// Override
const $overridden = $.override('user', (_deps, ctx) => {
  expectTypeOf(ctx.parent()).toEqualTypeOf<User>()
  expectTypeOf(ctx.scope).toEqualTypeOf<'test'>()
  return admin
})
expectTypeOf($overridden).toEqualTypeOf<typeof $>()
$.override('cart', ({ user }) => ({ items: [user.name] }))
// @ts-expect-error TS2322 Type 'number' is not assignable to type 'User'
$.override('user', () => 42)
// @ts-expect-error TS2345 Argument of type '"usr"' is not assignable to parameter
$.override('usr', () => ada)

// Re-declare (narrowing only)
const $admin = $.let('user', (): Admin => admin)
expectTypeOf($admin.user).toEqualTypeOf<Admin>()
expectTypeOf($admin.cart).toEqualTypeOf<Cart>()
$admin.override('user', (_deps, ctx) => {
  expectTypeOf(ctx.parent()).toEqualTypeOf<Admin>()
  return admin
})
// @ts-expect-error TS2322 Type 'number' is not assignable to type 'User'
$.let('user', () => 42)
// @ts-expect-error TS2322 Type 'string' is not assignable to type 'User'
$.let('user', () => 'Ada')

// Async and eager
const $async = lazy.let('saved', async (): Promise<User> => ada)
expectTypeOf($async.saved).toEqualTypeOf<Promise<User>>()
const $eager = lazy.eager('db', async (): Promise<Db> => db)
expectTypeOf($eager.db).toEqualTypeOf<Db>()
$eager.override('db', async (_deps, ctx) => {
  expectTypeOf(ctx.parent()).toEqualTypeOf<Promise<Db>>()
  return await ctx.parent()
})
$eager.override('db', () => db)
// @ts-expect-error TS2322 Type 'Promise<string>' is not assignable to type
$eager.override('db', async () => 'db')

// Scopes
const $scoped = lazy
  .let(
    'config',
    (_deps, ctx) => {
      expectTypeOf(ctx.scope).toEqualTypeOf<'file'>()
      expectTypeOf(ctx.task).toEqualTypeOf<undefined>()
      return { retries: 3 }
    },
    { scope: 'file' },
  )
  .let(
    'pool',
    ({ config }, ctx) => {
      expectTypeOf(ctx.scope).toEqualTypeOf<'file'>()
      return config.retries
    },
    { scope: 'file' },
  )
  .let('shared', () => 1, { scope: 'worker' })
  .let(
    'both',
    ({ shared }, ctx) => {
      expectTypeOf(ctx.scope).toEqualTypeOf<'worker'>()
      return shared
    },
    { scope: 'worker' },
  )
  .let('perTest', ({ config, shared, pool }, ctx) => {
    expectTypeOf(ctx.task).toEqualTypeOf<TaskInfo>()
    return config.retries + shared + pool
  })
expectTypeOf($scoped.perTest).toEqualTypeOf<number>()
// @ts-expect-error TS2339 Property 'perTest' does not exist
lazy.let('perTest', () => 1).let('file', ({ perTest }) => perTest, { scope: 'file' })
const $fileConfig = lazy.let('config', () => 1, { scope: 'file' })
// @ts-expect-error TS2339 Property 'config' does not exist
$fileConfig.let('worker', ({ config }) => config, { scope: 'worker' })
// @ts-expect-error TS2322 Type '"process"' is not assignable to type 'Scope | undefined'
lazy.let('x', () => 1, { scope: 'process' })
// @ts-expect-error TS2322 Type 'string' is not assignable to type 'number'
lazy.let('x', () => 1, { timeout: '5s' })

// Reserved keys
expectTypeOf<CheckKey<'thenable'>>().toEqualTypeOf<'thenable'>()
expectTypeOf<
  CheckKey<'then'>
>().toEqualTypeOf<"Error: 'then' is reserved and cannot be a lazy key">()
expectTypeOf<'let' | 'toJSON' | 'asymmetricMatch'>().toExtend<ReservedKey>()
const $thenable = lazy.let('thenable', () => 1)
expectTypeOf($thenable.thenable).toEqualTypeOf<number>()
async function awaitHandle(): Promise<void> {
  const awaited = await $thenable
  expectTypeOf(awaited).toEqualTypeOf<typeof $thenable>()
}
void awaitHandle
// @ts-expect-error TS2345 'override' is reserved and cannot be a lazy key
lazy.let('override', () => 1)
// @ts-expect-error TS2345 'let' is reserved and cannot be a lazy key
lazy.let('let', () => 1)
// @ts-expect-error TS2345 'constructor' is reserved and cannot be a lazy key
lazy.let('constructor', () => 1)
// @ts-expect-error TS2345 'toJSON' is reserved and cannot be a lazy key
lazy.eager('toJSON', () => 1)

// A key that is not a literal would skip the reserved and re-declare checks and add an index signature
declare const wideKey: string
// @ts-expect-error TS2345 lazy keys must be string literals
lazy.let('x', () => 1).let(wideKey, () => 'q')
// @ts-expect-error TS2345 lazy keys must be string literals
lazy.eager(wideKey, () => 1)
// @ts-expect-error TS2345 Argument of type 'string' is not assignable to parameter of type
$.override(wideKey, () => ada)

// $.from(ctx)
expectTypeOf($.from(testCtx)).toEqualTypeOf<{ readonly user: User; readonly cart: Cart }>()
// @ts-expect-error TS2345 Argument of type 'number' is not assignable to parameter
$.from(1)

// Shared examples
const aCollection = sharedExamples<{ subject: Stack }, [label: string]>(
  'a collection',
  ($c, label) => {
    expectTypeOf($c.subject).toEqualTypeOf<Stack>()
    expectTypeOf(label).toEqualTypeOf<string>()
    const $size = $c.let('size', ({ subject }) => subject.size)
    expectTypeOf($size.size).toEqualTypeOf<number>()
    // @ts-expect-error TS2339 Property 'override' does not exist
    $c.override('subject', () => stack)
  },
)
const $stack = lazy.let('subject', (): Stack => stack).let('other', () => 1)
itBehavesLike(aCollection, $stack, 'stack')
includeExamples(aCollection, $stack, 'stack')
const $numeric = lazy.let('subject', () => 1)
// @ts-expect-error TS2345 Type 'number' is not assignable to type 'Stack'
itBehavesLike(aCollection, $numeric, 'stack')
// @ts-expect-error TS2345 Property 'subject' is missing in type
itBehavesLike(aCollection, $, 'stack')
// @ts-expect-error TS2345 Type 'number' is not assignable to type 'string'
itBehavesLike(aCollection, $stack, 1)

// Shared context
const $db = lazy.let('db', (): Db => db)
const repoContext = sharedContext('repo context', ($d: SharedLazy<{ db: Db }>) =>
  $d.let('repo', ({ db: source }): Repo => {
    expectTypeOf(source).toEqualTypeOf<Db>()
    return repo
  }),
)
const $withRepo = includeContext($db, repoContext)
expectTypeOf($withRepo.repo).toEqualTypeOf<Repo>()
expectTypeOf($withRepo.db).toEqualTypeOf<Db>()
// @ts-expect-error TS2345 Property 'db' is missing in type
includeContext($, repoContext)
expectTypeOf<Values<{ a: 1 }>>().toEqualTypeOf<{ readonly a: 1 }>()
