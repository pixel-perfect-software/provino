import type { AnyFunction } from './policy/behaviour.ts'

/**
 * Values `structuredClone` copies as they are.
 * @public
 */
export type CloneLeaf =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | RegExp
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView

/**
 * A JSON value. Every JSON value clones, so `CloneSafe` accepts one without walking it (walking a
 * recursive alias like this one exceeds TypeScript's instantiation depth).
 * @public
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** Any class constructor: `structuredClone` can't copy one, even when it has no methods. */
type AnyConstructor = abstract new (...args: never[]) => unknown

/** Values that can never cross a thread. */
type Unclonable = AnyFunction | AnyConstructor | symbol

/** Keys of `T` whose values can't cross a thread. */
type UnclonableKeys<T> = { [K in keyof T]-?: T[K] extends Unclonable ? K : never }[keyof T]

/**
 * `structuredClone` keeps only an error's `name`, `message`, `stack` and `cause`, so an error
 * with any other field (or a method) would lose it.
 */
type CloneSafeError<T> = [UnclonableKeys<T> | Exclude<keyof T, keyof Error>] extends [never]
  ? T
  : never

/**
 * Types can't tell an `Error` instance from a plain record with `name` and `message`. A record
 * says it is plain data by declaring the phantom member `__record?: never` (as `SerializedError`
 * does); it is then checked field by field, like any object.
 */
type PlainRecordKey = '__record'

/** A `ModuleRef` passes while its phantom `__fn` is absent; a `__fn` actually set is rejected. */
type CloneSafeRef<T> = T extends { readonly __fn: unknown }
  ? never
  : { [K in keyof T]: K extends '__fn' ? T[K] : CloneSafe<T[K]> }

/**
 * `T` with every part that can't cross a thread replaced by `never`, so `T extends CloneSafe<T>`
 * holds only for clone-safe types. Use it as a constraint: `function send<T>(value: T &
 * CloneSafe<T>)` rejects `send(() => {})`.
 *
 * - Rejected: functions, constructors, symbols, and objects with methods (so class instances
 *   other than `Date`, `RegExp`, `Map`, `Set` and typed arrays).
 * - `Error`: only a plain `Error`/`TypeError`/…; an error with extra fields (a `code`) is
 *   rejected, so send it as a `SerializedError` instead. A record with `name` and `message`
 *   that declares the phantom `__record?: never` is plain data and is checked field by field.
 * - `ModuleRef`: a `{ module, export }` object without its phantom `__fn` set passes.
 * - A `JsonValue` (any type assignable to it) passes without being walked.
 * - `unknown` and `Record<string, unknown>` are rejected (nothing proves them clone-safe);
 *   `object` and `{}` pass, because they say nothing about their members.
 * - Leaves are matched by type, so a leaf intersected with extra members (`Date & { … }`)
 *   passes, though `structuredClone` drops the extras.
 * @public
 */
export type CloneSafe<T> = T extends Unclonable
  ? never
  : T extends Error
    ? PlainRecordKey extends keyof T
      ? { [K in keyof T]: CloneSafe<T[K]> }
      : CloneSafeError<T>
    : T extends { readonly module: string; readonly export: string }
      ? CloneSafeRef<T>
      : T extends CloneLeaf | JsonValue
        ? T
        : T extends ReadonlyMap<infer K, infer V>
          ? T extends Map<K, V>
            ? Map<CloneSafe<K>, CloneSafe<V>>
            : ReadonlyMap<CloneSafe<K>, CloneSafe<V>>
          : T extends ReadonlySet<infer V>
            ? T extends Set<V>
              ? Set<CloneSafe<V>>
              : ReadonlySet<CloneSafe<V>>
            : { [K in keyof T]: CloneSafe<T[K]> }
