// The native core's status (Track 10, T10.1). `@provino/native` (Phase 3) returns a `NativeStatus`
// from its loader; the coordinator prints why a run is in JS mode once. Types only: `provino`
// depends on `@provino/native` as an optional dependency, and every consumer of these types works
// whether or not it is installed.

/**
 * A platform the native core ships a binary for: the suffix of its `@provino/native-<triple>`
 * package. Everything else runs on the TypeScript implementation.
 * @public
 */
export type NativeTriple =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64-gnu'
  | 'linux-x64-musl'
  | 'linux-arm64-gnu'
  | 'linux-arm64-musl'
  | 'win32-x64-msvc'
  | 'win32-arm64-msvc'
  | 'freebsd-x64'

/**
 * Why the native path is not in use. The coordinator shows it once.
 * @public
 */
export type NativeUnavailableReason =
  /** `PROVINO_NATIVE=0`, or `native: false` in the config. */
  | { readonly kind: 'disabled'; readonly by: 'env' | 'config' }
  | {
      readonly kind: 'unsupported-platform'
      readonly platform: string
      readonly arch: string
      readonly libc: 'glibc' | 'musl' | null
    }
  | {
      readonly kind: 'not-installed'
      readonly expectedPackage: `@provino/native-${NativeTriple}`
      readonly errors: readonly Error[]
    }
  | { readonly kind: 'version-mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'abi-mismatch'; readonly abiVersion: number; readonly required: number }
  | { readonly kind: 'load-error'; readonly path: string; readonly error: Error }

/**
 * Whether the native core loaded: its triple, version and file, or the reason it did not.
 * @public
 */
export type NativeStatus =
  | {
      readonly loaded: true
      readonly triple: NativeTriple
      readonly version: string
      readonly path: string
    }
  | { readonly loaded: false; readonly reason: NativeUnavailableReason }
