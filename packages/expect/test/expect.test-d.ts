// The public API of @provino/expect.
import {
  AsymmetricMatcher,
  type CreateExpectOptions,
  createExpect,
  createMatcherRegistry,
  createStateSource,
  type ExpectError,
  type ExpectErrorCode,
  equalityTesters,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatcherContext,
  type MatcherRegistry,
  type MatcherResultError,
  type MatchersSlot,
  type RegistrySnapshot,
  type SlotHandle,
  type SnapshotMatchersOptions,
  type StateSource,
  snapshotMatchers,
  snapshotRegistry,
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
