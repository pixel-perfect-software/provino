import { createRequire } from 'node:module'

/** The packages that load a native Oxc binding (`@oxc-<name>/binding-<platform>`). */
const OXC_PACKAGES: readonly string[] = ['oxc-parser', 'oxc-transform', 'oxc-resolver']

/**
 * The platform part of an Oxc binding package's name: `darwin-arm64`, `linux-x64-gnu`,
 * `linux-arm64-musl`, `win32-x64-msvc`, `freebsd-x64`.
 * @internal
 */
export function bindingTriple(platform: string, arch: string, musl: boolean): string {
  switch (platform) {
    case 'win32':
      return `win32-${arch}-msvc`
    case 'linux':
      return arch === 'arm' ? 'linux-arm-gnueabihf' : `linux-${arch}-${musl ? 'musl' : 'gnu'}`
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

/** The error and its `cause` chain, as the text a loader failure would carry. */
function chainText(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 6; depth++) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join('\n')
}

/**
 * The one message for an Oxc binding that did not load, or `undefined` when `error` is anything
 * else. The parser, the transform and the resolver each load a native binding from an optional
 * dependency named for the platform, and each fails with a long message that names the last package
 * it tried, not this machine's. This names this machine's: `@oxc-parser/binding-darwin-arm64`
 * and the other two, those that can't be found (all three when the files are there but won't load).
 * @internal
 */
export function missingBindingMessage(
  error: unknown,
  probe: BindingProbe = machine(),
): string | undefined {
  const text = chainText(error)
  const isBinding =
    /Cannot find native binding/.test(text) ||
    /Cannot find module '@oxc-(?:parser|transform|resolver)\/binding-/.test(text) ||
    /@oxc-(?:parser|transform|resolver)\/binding-[^\s'"]*\.node/.test(text)
  if (!isBinding) return undefined
  const triple = bindingTriple(probe.platform, probe.arch, probe.musl)
  const all = OXC_PACKAGES.map((name) => ({
    base: name,
    binding: `@${name}/binding-${triple}`,
  }))
  const missing = all.filter(({ base, binding }) => !probe.resolves(base, binding))
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
