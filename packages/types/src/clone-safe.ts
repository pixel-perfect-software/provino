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
  | Error
  | ArrayBuffer
  | ArrayBufferView

/**
 * `T` with every part that can't cross a thread replaced by `never`, so `T extends CloneSafe<T>`
 * holds only for clone-safe types. Functions, symbols and objects with methods (class instances
 * other than `Error`, `Date`, `RegExp`, `Map`, `Set` and typed arrays) are rejected. In an
 * object with string `module` and `export` keys, the phantom `__fn` is skipped, so a `ModuleRef`
 * doesn't count as holding a function (Track 1 §Spikes). `Error` is matched by shape, so any
 * object with string `name` and `message` passes as one.
 *
 * Use it as a constraint: `function send<T>(value: T & CloneSafe<T>)` rejects `send(() => {})`.
 * @public
 */
export type CloneSafe<T> = T extends AnyFunction | symbol
  ? never
  : T extends { readonly module: string; readonly export: string }
    ? { [K in keyof T]: K extends '__fn' ? T[K] : CloneSafe<T[K]> }
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
