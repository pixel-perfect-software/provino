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

/** Any class constructor: `structuredClone` can't copy one, even when it has no methods. */
type AnyConstructor = abstract new (...args: never[]) => unknown

/** Keys of `T` whose values can't cross a thread. */
type FunctionKeys<T> = {
  [K in keyof T]-?: T[K] extends AnyFunction | AnyConstructor | symbol ? K : never
}[keyof T]

/**
 * `T` with every part that can't cross a thread replaced by `never`, so `T extends CloneSafe<T>`
 * holds only for clone-safe types. Use it as a constraint: `function send<T>(value: T &
 * CloneSafe<T>)` rejects `send(() => {})`.
 *
 * - Rejected: functions, constructors, symbols, and objects with methods (so class instances
 *   other than `Date`, `RegExp`, `Map`, `Set` and typed arrays).
 * - `Error`: only a plain `Error`/`TypeError`/…, since `structuredClone` drops every property
 *   but `name`, `message`, `stack` and `cause`. An error with extra fields (a `code`) is
 *   rejected: send it as a serialized error record instead.
 * - `ModuleRef`: a `{ module, export }` object whose phantom `__fn` is absent passes. A `__fn`
 *   that is actually set is rejected.
 * - `unknown` and `Record<string, unknown>` are rejected (nothing proves them clone-safe);
 *   `object` and `{}` pass, because they say nothing about their members.
 * - Leaves are matched by type, so a leaf intersected with extra members (`Date & { … }`)
 *   passes, though `structuredClone` drops the extras.
 * @public
 */
export type CloneSafe<T> = T extends AnyFunction | AnyConstructor | symbol
  ? never
  : T extends Error
    ? [FunctionKeys<T> | Exclude<keyof T, keyof Error>] extends [never]
      ? T
      : never
    : T extends { readonly module: string; readonly export: string }
      ? T extends { readonly __fn: unknown }
        ? never
        : { [K in keyof T]: K extends '__fn' ? T[K] : CloneSafe<T[K]> }
      : T extends CloneLeaf
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
