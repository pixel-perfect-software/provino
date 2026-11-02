import type {
  CloneSafe,
  Contribution,
  ModuleRef,
  Policy,
  SerializedPolicy,
  SnapshotKey,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

/** Stands in for an RPC send: only clone-safe values are accepted. */
declare function send<T>(value: T & CloneSafe<T>): void

// What crosses to the worker is clone-safe; the policy with closures is not.
expectTypeOf<SerializedPolicy>().toExtend<CloneSafe<SerializedPolicy>>()
expectTypeOf<Policy>().not.toExtend<CloneSafe<Policy>>()

// structuredClone's leaves pass as they are.
interface Leaves {
  readonly s: string
  readonly n: number
  readonly b: boolean
  readonly big: bigint
  readonly nil: null
  readonly date: Date
  readonly re: RegExp
  readonly err: Error
  readonly bytes: Uint8Array
  readonly map: Map<string, number>
  readonly set: ReadonlySet<string>
  readonly list: readonly { readonly x: number }[]
  readonly tuple: readonly [number, string]
  readonly optional?: string
}
expectTypeOf<Leaves>().toExtend<CloneSafe<Leaves>>()
expectTypeOf<CloneSafe<Leaves>>().toEqualTypeOf<Leaves>()

// A ModuleRef's phantom `__fn` is not a function property.
expectTypeOf<ModuleRef<SnapshotKey>>().toExtend<CloneSafe<ModuleRef<SnapshotKey>>>()
// Contribution options are checked: closures don't cross.
expectTypeOf<Contribution<'environment', { readonly url: string }>>().toExtend<
  CloneSafe<Contribution<'environment', { readonly url: string }>>
>()
expectTypeOf<Contribution<'environment', { readonly f: () => void }>>().not.toExtend<
  CloneSafe<Contribution<'environment', { readonly f: () => void }>>
>()

class Counter {
  count = 0
  increment(): void {
    this.count++
  }
}

send({ a: 1, b: ['x'], when: new Date() })
send({ ref: { module: 'file:///x.ts', export: 'f' } as ModuleRef<() => void> })
// @ts-expect-error a function
send(() => {})
// @ts-expect-error a nested function
send({ nested: { fn: () => 1 } })
// @ts-expect-error a symbol
send({ id: Symbol('x') })
// @ts-expect-error a class instance with methods
send(new Counter())
// @ts-expect-error a function inside a Map
send(new Map([['k', () => {}]]))
// @ts-expect-error a ModuleRef-shaped object with an extra closure
send({ module: 'm', export: 'e', run: () => {} })
