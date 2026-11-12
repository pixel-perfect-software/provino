import type { NativeStatus, NativeTriple, NativeUnavailableReason } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The nine platforms the native core ships for, and no others.
expectTypeOf<NativeTriple>().toEqualTypeOf<
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64-gnu'
  | 'linux-x64-musl'
  | 'linux-arm64-gnu'
  | 'linux-arm64-musl'
  | 'win32-x64-msvc'
  | 'win32-arm64-msvc'
  | 'freebsd-x64'
>()
// @ts-expect-error not a platform with a binary
const unsupported: NativeTriple = 'linux-riscv64-gnu'
void unsupported

// The reasons, by `kind`.
expectTypeOf<NativeUnavailableReason['kind']>().toEqualTypeOf<
  | 'disabled'
  | 'unsupported-platform'
  | 'not-installed'
  | 'version-mismatch'
  | 'abi-mismatch'
  | 'load-error'
>()

// `not-installed` names the package that was expected, as a template literal over the triples.
declare const notInstalled: Extract<NativeUnavailableReason, { kind: 'not-installed' }>
expectTypeOf(notInstalled.expectedPackage).toEqualTypeOf<`@provino/native-${NativeTriple}`>()
expectTypeOf(notInstalled.errors).toEqualTypeOf<readonly Error[]>()
// @ts-expect-error a package that isn't a native-<triple> one
const wrongPackage: typeof notInstalled.expectedPackage = '@provino/native-win32-ia32-msvc'
void wrongPackage

// `libc` is a string or null, never left out: Linux says which, other systems say null.
declare const unsupportedPlatform: Extract<
  NativeUnavailableReason,
  { kind: 'unsupported-platform' }
>
expectTypeOf(unsupportedPlatform.libc).toEqualTypeOf<'glibc' | 'musl' | null>()

// The status narrows on `loaded`: a loaded core has a triple, an unloaded one has a reason.
declare const status: NativeStatus
if (status.loaded) {
  expectTypeOf(status.triple).toEqualTypeOf<NativeTriple>()
  expectTypeOf(status.version).toEqualTypeOf<string>()
  expectTypeOf(status.path).toEqualTypeOf<string>()
  // @ts-expect-error `reason` exists only when the core did not load
  status.reason
} else {
  expectTypeOf(status.reason).toEqualTypeOf<NativeUnavailableReason>()
  // @ts-expect-error `triple` exists only when the core loaded
  status.triple
}
expectTypeOf<NativeStatus>().toExtend<{ readonly loaded: boolean }>()

// Under `exactOptionalPropertyTypes` a loaded status cannot be built without its triple, and an
// unloaded one cannot carry one.
// @ts-expect-error a loaded status needs `triple`, `version` and `path`
const noTriple: NativeStatus = { loaded: true, version: '1.0.0', path: '/x.node' }
void noTriple
// @ts-expect-error an unloaded status needs a `reason`
const noReason: NativeStatus = { loaded: false }
void noReason

// The statuses are read-only: a consumer cannot flip `loaded`.
declare const frozen: Extract<NativeStatus, { loaded: true }>
// @ts-expect-error `loaded` is read-only
frozen.loaded = true
