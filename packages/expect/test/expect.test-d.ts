// The public API of @provino/expect.
import {
  AsymmetricMatcher,
  type CreateExpectOptions,
  createEndOfTest,
  createExpect,
  createMatcherRegistry,
  createStateSource,
  type EndOfTest,
  type EndOfTestAttempt,
  type EndOfTestOptions,
  type ExpectError,
  type ExpectErrorCode,
  equalityTesters,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatcherContext,
  type MatcherRegistry,
  type MatcherResultError,
  type MatchersSlot,
  type PollTimers,
  type RegistrySnapshot,
  type SlotHandle,
  type SnapshotMatchersOptions,
  type StateSource,
  snapshotMatchers,
  snapshotRegistry,
  type UnawaitedAssertion,
} from '@provino/expect'
import type {
  Assertion,
  AsymmetricMatcherLike,
  CurrentTest,
  EqualityTester,
  ExpectPolicy,
  ExpectStatic,
  MatcherResult,
  MatcherSet,
  MatcherState,
  PendingAssertion,
  PollAssertion,
  PollContext,
  PollOptions,
  SnapshotPlugin,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const currentTest: CurrentTest
declare const options: CreateExpectOptions

expectTypeOf(createExpect).returns.toEqualTypeOf<ExpectStatic>()
expectTypeOf(createStateSource).returns.toEqualTypeOf<StateSource>()
expectTypeOf(createMatcherRegistry).returns.toEqualTypeOf<MatcherRegistry>()
expectTypeOf(installMatchersSlot).returns.toEqualTypeOf<SlotHandle>()
expectTypeOf(MATCHERS_SLOT).toEqualTypeOf<typeof MATCHERS_SLOT>()
expectTypeOf(snapshotRegistry).parameter(0).toEqualTypeOf<MatcherRegistry>()
expectTypeOf(snapshotRegistry).parameter(1).toEqualTypeOf<ExpectStatic | undefined>()
expectTypeOf(snapshotRegistry).returns.toEqualTypeOf<RegistrySnapshot>()
expectTypeOf<RegistrySnapshot>().toEqualTypeOf<{ restore(): void }>()
expectTypeOf<MatchersSlot['state']>().toEqualTypeOf<MatcherState>()
expectTypeOf<ExpectError['code']>().toEqualTypeOf<ExpectErrorCode>()
expectTypeOf<MatcherResultError>().toExtend<Error>()
expectTypeOf<MatcherResultError['matcherResult']>().toEqualTypeOf<
  (Omit<MatcherResult, 'message'> & { readonly message: string }) | undefined
>()

const expect = createExpect(options)
expectTypeOf(expect(1)).toEqualTypeOf<Assertion>()
expectTypeOf(expect(1).toBe(2)).toEqualTypeOf<void>()
expectTypeOf(expect(1).not.toEqual(2)).toEqualTypeOf<void>()
expectTypeOf(expect(Promise.resolve(1)).resolves.toBe(1)).toEqualTypeOf<Promise<void>>()
expectTypeOf(expect(Promise.reject(1)).rejects.not.toBe(2)).toEqualTypeOf<Promise<void>>()
expectTypeOf(expect.any(Number)).toEqualTypeOf<AsymmetricMatcherLike>()
expectTypeOf(expect.not.objectContaining({})).toEqualTypeOf<AsymmetricMatcherLike>()
expectTypeOf(expect.getState()).toEqualTypeOf<MatcherState>()

// @ts-expect-error an unregistered matcher name isn't on the type either
expect(1).toBeFoo()
// @ts-expect-error `.not` has no `.resolves` (it reads undefined at runtime, as in Jest)
void expect(Promise.resolve(1)).not.resolves
// @ts-expect-error a matcher's parameters are typed
expect(1).toHaveLength('2')
// @ts-expect-error `expect.not` has no `any`
expect.not.any(Number)
// @ts-expect-error the table is required
createExpect({ policy: options.policy, source: options.source })
// @ts-expect-error `expand` comes from the policy and is required
createStateSource(currentTest, { nameSeparator: ' ' })
// @ts-expect-error the slot needs the registry `createExpect` will fill
installMatchersSlot(options.source)
// @ts-expect-error a snapshot is of a registry, not of an `expect`
snapshotRegistry(expect)
// @ts-expect-error the second argument is the `expect` function, not its registry
snapshotRegistry(createMatcherRegistry(), createMatcherRegistry())
snapshotRegistry(createMatcherRegistry(), expect).restore()
// @ts-expect-error `restore` takes nothing
snapshotRegistry(createMatcherRegistry()).restore(1)
// @ts-expect-error the base is abstract
new AsymmetricMatcher(1)

class Even extends AsymmetricMatcher<void> {
  asymmetricMatch(other: unknown): boolean {
    const context: MatcherContext = this.getMatcherContext()
    return context.equals(Number(other) % 2, 0)
  }
  toString(): string {
    return 'Even'
  }
}
expectTypeOf(new Even(undefined)).toExtend<AsymmetricMatcherLike>()

// T7.8: the async policies.
declare const endOfTestOptions: EndOfTestOptions
declare const attempt: EndOfTestAttempt

expectTypeOf(createEndOfTest).parameter(0).toEqualTypeOf<EndOfTestOptions>()
expectTypeOf(createEndOfTest).returns.toEqualTypeOf<EndOfTest>()
expectTypeOf<EndOfTest>().parameter(0).toEqualTypeOf<EndOfTestAttempt>()
expectTypeOf<EndOfTest>().returns.toEqualTypeOf<readonly Error[]>()
expectTypeOf(createEndOfTest(endOfTestOptions)(attempt)).toEqualTypeOf<readonly Error[]>()
expectTypeOf<EndOfTestOptions['hasAssertionsWhenFailed']>().toEqualTypeOf<'skip' | 'check'>()
expectTypeOf<EndOfTestAttempt>().toExtend<{ attempt: number; repeat: number }>()
expectTypeOf<UnawaitedAssertion>().toEqualTypeOf<'ignore' | 'fail'>()
expectTypeOf<CreateExpectOptions['unawaited']>().toEqualTypeOf<UnawaitedAssertion | undefined>()
expectTypeOf<CreateExpectOptions['pollTimers']>().toEqualTypeOf<PollTimers | undefined>()
expectTypeOf<PollTimers['advance']>().toEqualTypeOf<
  ((ms: number) => Promise<void> | undefined) | undefined
>()
expectTypeOf<MatcherState['pendingAsync']>().toEqualTypeOf<Set<PendingAssertion>>()
expectTypeOf<PendingAssertion['kind']>().toEqualTypeOf<'settled' | 'poll'>()

// `soft`, `poll` and `unreachable` are optional: a dialect's policy and table decide.
expectTypeOf(expect.soft).toEqualTypeOf<((actual: unknown) => Assertion) | undefined>()
expectTypeOf(expect.poll).toEqualTypeOf<
  ((fn: (context: PollContext) => unknown, options?: PollOptions) => PollAssertion) | undefined
>()
expectTypeOf(expect.unreachable).toEqualTypeOf<((message?: string) => never) | undefined>()
expectTypeOf<PollContext['signal']>().toEqualTypeOf<AbortSignal>()
expectTypeOf<PollAssertion['toBe']>().returns.toEqualTypeOf<Promise<void>>()
expectTypeOf<PollAssertion['not']['toBe']>().returns.toEqualTypeOf<Promise<void>>()

declare const poll: NonNullable<ExpectStatic['poll']>
expectTypeOf(poll(() => 1, { interval: 10, timeout: 100 }).toBe(1)).toEqualTypeOf<Promise<void>>()
// @ts-expect-error a polled assertion has no `resolves`
void poll(() => 1).resolves
// @ts-expect-error the callback is a function
poll(1)
// @ts-expect-error the interval is a number
poll(() => 1, { interval: '10' })
// @ts-expect-error `message` is not an option
poll(() => 1, { message: 'x' })
// @ts-expect-error an unregistered matcher isn't on the type
poll(() => 1).toBeFoo()
// @ts-expect-error the soft form takes the value
expect.soft?.()
// @ts-expect-error the policy value is `'ignore' | 'fail'`
const badOptions: CreateExpectOptions = { ...options, unawaited: 'warn' }
void badOptions
// @ts-expect-error the policy value is required
createEndOfTest({ source: endOfTestOptions.source, messages: endOfTestOptions.messages })
// @ts-expect-error `hasAssertionsWhenFailed` is `'skip' | 'check'`
createEndOfTest({ ...endOfTestOptions, hasAssertionsWhenFailed: 'ignore' })
// @ts-expect-error an attempt says whether it failed
createEndOfTest(endOfTestOptions)({ test: { id: 't' }, attempt: 0, repeat: 0 })
// The snapshot matchers (T7.10) and the equality policies (T7.7).
expectTypeOf(snapshotMatchers({ fileSnapshot: false })).toEqualTypeOf<{
  readonly matchers: MatcherSet
  readonly promiseMatchers: MatcherSet
}>()
expectTypeOf<SnapshotMatchersOptions>().toEqualTypeOf<{ readonly fileSnapshot: boolean }>()
// @ts-expect-error the options name whether to include toMatchFileSnapshot
snapshotMatchers({})
declare const expectStatic: ExpectStatic
expectTypeOf(expectStatic.addSnapshotSerializer).parameters.toEqualTypeOf<[SnapshotPlugin]>()
// @ts-expect-error a serializer is an object with test and serialize (or print)
expectStatic.addSnapshotSerializer({ test: () => true })
expectTypeOf(expectStatic(1).toMatchSnapshot).toBeCallableWith()
expectTypeOf(expectStatic(1).toMatchSnapshot).toBeCallableWith('a hint')
expectTypeOf(expectStatic(1).toMatchSnapshot).toBeCallableWith({ id: 1 }, 'a hint')
// @ts-expect-error a hint is a string
expectStatic(1).toMatchSnapshot({ id: 1 }, 2)
expectTypeOf(expectStatic(() => {}).toThrowErrorMatchingSnapshot).toBeCallableWith('a hint')
// @ts-expect-error an inline snapshot is a string
expectStatic(() => {}).toThrowErrorMatchingInlineSnapshot(1)
expectTypeOf(expectStatic(Promise.resolve(1)).resolves.toMatchInlineSnapshot).returns.toEqualTypeOf<
  Promise<void>
>()
expectTypeOf(equalityTesters({ errors: 'assert', invalidDate: 'equal' })).toEqualTypeOf<
  EqualityTester[]
>()
// @ts-expect-error the policy's rule is one of its two names
equalityTesters({ errors: 'exact', invalidDate: 'equal' } satisfies ExpectPolicy['equality'])
