import type {
  CloneSafe,
  Contribution,
  JsonValue,
  ModuleRef,
  Policy,
  SerializedError,
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
// CloneSafe tells a contribution with clone-safe options from one with a closure (the
// Contribution type itself can't; see its TSDoc).
expectTypeOf<Contribution<'environment', { readonly url: string }>>().toExtend<
  CloneSafe<Contribution<'environment', { readonly url: string }>>
>()
expectTypeOf<Contribution<'environment', { readonly f: () => void }>>().not.toExtend<
  CloneSafe<Contribution<'environment', { readonly f: () => void }>>
>()
// SharedArrayBuffer clones (it is how workers share Atomics state).
expectTypeOf<SharedArrayBuffer>().toExtend<CloneSafe<SharedArrayBuffer>>()
// A plain Error clones; one with extra fields loses them, so it is rejected.
expectTypeOf<TypeError>().toExtend<CloneSafe<TypeError>>()
expectTypeOf<Error & { readonly code: string }>().not.toExtend<
  CloneSafe<Error & { readonly code: string }>
>()
// JSON values pass without being walked; a JSON-like object with a closure is still walked.
expectTypeOf<JsonValue>().toExtend<CloneSafe<JsonValue>>()
expectTypeOf<{ readonly a: JsonValue; readonly f: () => void }>().not.toExtend<
  CloneSafe<{ readonly a: JsonValue; readonly f: () => void }>
>()
// A record with an error's name and message that declares itself plain data (the phantom
// `__record?: never`) is checked field by field, so its extra fields clone.
interface PlainErrorRecord {
  readonly __record?: never
  readonly name: string
  readonly message: string
  readonly code: string
}
expectTypeOf<PlainErrorRecord>().toExtend<CloneSafe<PlainErrorRecord>>()
expectTypeOf<SerializedError>().toExtend<CloneSafe<SerializedError>>()
// A plain record still may not hide a closure.
interface BadRecord {
  readonly __record?: never
  readonly name: string
  readonly message: string
  readonly format: () => string
}
expectTypeOf<BadRecord>().not.toExtend<CloneSafe<BadRecord>>()

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
// @ts-expect-error a ModuleRef whose phantom __fn is actually set
send({ module: 'm', export: 'e', __fn: () => {} })
class PlainData {
  x = 1
}
// @ts-expect-error a constructor, even of a class with no methods
send(PlainData)
// @ts-expect-error an Error-shaped object with a method
send({ name: 'E', message: 'm', run: () => {} })
// @ts-expect-error a function as a Map key
send(new Map([[() => {}, 1]]))
// @ts-expect-error a function in a Set
send(new Set([() => {}]))
// @ts-expect-error a function in an array
send([() => 1])
