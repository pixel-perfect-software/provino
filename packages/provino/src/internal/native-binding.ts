import { createRequire } from 'node:module'

/** The packages that load a native Oxc binding (`@oxc-<name>/binding-<platform>`). */
const OXC_PACKAGES: readonly string[] = ['oxc-parser', 'oxc-transform', 'oxc-resolver']

/**
 * The platform part of an Oxc binding package's name: `darwin-arm64`, `linux-x64-gnu`,
 * `linux-arm64-musl`, `linux-arm-gnueabihf`, `android-arm-eabi`, `win32-x64-msvc`,
 * `freebsd-x64`. `native-binding.test.ts` holds every one against the keys of the installed
 * packages' `optionalDependencies`.
 * @internal
 */
export function bindingTriple(platform: string, arch: string, musl: boolean): string {
  switch (platform) {
    case 'win32':
      return `win32-${arch}-msvc`
    case 'linux':
      return arch === 'arm'
        ? `linux-arm-${musl ? 'musleabihf' : 'gnueabihf'}`
        : `linux-${arch}-${musl ? 'musl' : 'gnu'}`
    case 'android':
      return arch === 'arm' ? 'android-arm-eabi' : `android-${arch}`
    default:
      return `${platform}-${arch}`
  }
}

/**
 * What the message needs to know about this machine, and whether a binding package can be found
 * from the package that loads it.
 * @internal
 */
export interface BindingProbe {
  readonly platform: string
  readonly arch: string
  readonly musl: boolean
  /** Whether `bindingPackage` resolves from where `basePackage` is installed. */
  readonly resolves: (basePackage: string, bindingPackage: string) => boolean
}

/** The running machine: the libc is asked of the process report, which only an error path reads. */
function machine(): BindingProbe {
  const header: unknown = (process.report?.getReport() as { header?: unknown } | undefined)?.header
  const glibc =
    typeof header === 'object' && header !== null && 'glibcVersionRuntime' in header
      ? header.glibcVersionRuntime
      : undefined
  return {
    platform: process.platform,
    arch: process.arch,
    musl: process.platform === 'linux' && glibc === undefined,
    resolves(basePackage, bindingPackage) {
      try {
        const base = createRequire(import.meta.url).resolve(basePackage)
        createRequire(base).resolve(bindingPackage)
        return true
      } catch {
        return false
      }
    },
  }
}

/** The error and its `cause` chain: each message, and each stack (which names the package that threw). */
function chainText(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 6; depth++) {
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? '')
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join('\n')
}

/** `oxc-parser|oxc-transform|oxc-resolver`, for the patterns below. */
const OXC_NAMES = OXC_PACKAGES.join('|')

/** An Oxc package named by its scope (`@oxc-parser/…`) or by its place in node_modules. */
const NAMES_OXC = new RegExp(
  `@(?:${OXC_NAMES})/|[\\\\/]node_modules[\\\\/](?:\\.pnpm[\\\\/][^\\\\/]+[\\\\/]node_modules[\\\\/])?(?:${OXC_NAMES})[\\\\/]`,
)

/** A binding file that is there and failed to load (the loader's own words for it). */
const FAILED_TO_LOAD = /dlopen|\.node\b/

/**
 * The one message for an Oxc binding that did not load, or `undefined` when `error` is anything
 * else. The parser, the transform and the resolver each load a native binding from an optional
 * dependency named for the platform, and each fails with a long message that names the last package
 * it tried, not this machine's. This names this machine's: `@oxc-parser/binding-darwin-arm64`
 * and the other two, those that can't be found (all three when the files are there but won't load).
 *
 * The probe decides first: when any of this platform's three packages can't be resolved, that is
 * the message, whatever the error says (the loaders word it three ways, and the error is only
 * what the first one tried). Only when all three resolve does the text matter, and then the error
 * must say a binding file failed to load and name an Oxc package: swc, lightningcss and the rest
 * ship the same loader, and theirs is not ours.
 * @internal
 */
export function missingBindingMessage(
  error: unknown,
  probe: BindingProbe = machine(),
): string | undefined {
  const triple = bindingTriple(probe.platform, probe.arch, probe.musl)
  const all = OXC_PACKAGES.map((name) => ({
    base: name,
    binding: `@${name}/binding-${triple}`,
  }))
  const missing = all.filter(({ base, binding }) => !probe.resolves(base, binding))
  if (missing.length === 0) {
    const text = chainText(error)
    if (!(FAILED_TO_LOAD.test(text) && NAMES_OXC.test(text))) return undefined
  }
  const named = (missing.length > 0 ? missing : all).map(({ binding }) => binding)
  const where = `${probe.platform} ${probe.arch}${probe.musl ? ' (musl)' : ''}`
  return [
    `Provino: the native Oxc binding for ${where} is ${missing.length > 0 ? 'not installed' : 'installed but did not load'}, so Provino cannot parse, transform or resolve files.`,
    `  ${missing.length > 0 ? 'Missing' : 'Check'}: ${named.join(', ')}`,
    '  They are optional dependencies of oxc-parser, oxc-transform and oxc-resolver. Install again with',
    "  optional dependencies on (no --omit=optional or --no-optional) and this platform allowed (pnpm's",
    '  supportedArchitectures); if npm skipped them from an old lockfile, delete package-lock.json and',
    '  node_modules first (https://github.com/npm/cli/issues/4828).',
    '',
  ].join('\n')
}
