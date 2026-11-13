import { mkdirSync } from 'node:fs'
import { type CommandResult, runCommand, runCommandAsync } from './exec.ts'
import type { WorkspacePackage } from './workspace.ts'

/** A package packed to a tarball. */
export interface PackedPackage {
  readonly name: string
  readonly version: string
  /** Absolute path of the `.tgz`. */
  readonly tarball: string
  /** The paths the tarball holds, as `pnpm pack` listed them. */
  readonly files: readonly string[]
}

/**
 * pnpm, as the running `pnpm` script named it, else the one on `PATH`.
 * @internal
 */
export function pnpm(): { readonly command: string; readonly prefix: readonly string[] } {
  const execPath = process.env.npm_execpath
  if (execPath?.includes('pnpm') === true && /\.[cm]?js$/.test(execPath)) {
    return { command: process.execPath, prefix: [execPath] }
  }
  return { command: 'pnpm', prefix: [] }
}

/** The `pnpm pack` command line for one package, and where it runs. */
function packCommand(
  pkg: WorkspacePackage,
  outDir: string,
): { command: string; args: string[]; options: { cwd: string } } {
  mkdirSync(outDir, { recursive: true })
  const { command, prefix } = pnpm()
  return {
    command,
    args: [...prefix, 'pack', '--pack-destination', outDir, '--json'],
    options: { cwd: pkg.dir },
  }
}

/** What `pnpm pack --json` printed, as a `PackedPackage`; anything else is an error naming the package. */
function packed(pkg: WorkspacePackage, result: CommandResult): PackedPackage {
  if (result.status !== 0) {
    // `error` is set when pnpm could not start or was killed for outrunning its deadline.
    throw new Error(`pnpm pack failed in ${pkg.rel}:\n${result.output}`, { cause: result.error })
  }
  // stdout only: a WARN on stderr is not part of the JSON.
  const start = result.stdout.indexOf('{')
  let json: unknown
  try {
    json = JSON.parse(result.stdout.slice(start))
  } catch (error) {
    throw new Error(`pnpm pack printed no JSON in ${pkg.rel}:\n${result.output}`, { cause: error })
  }
  if (typeof json !== 'object' || json === null) throw new Error(`pnpm pack: no JSON in ${pkg.rel}`)
  const { name, version, filename, files } = json as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string' || typeof filename !== 'string') {
    throw new Error(`pnpm pack printed an unexpected result in ${pkg.rel}:\n${result.output}`)
  }
  const paths = Array.isArray(files)
    ? files.flatMap((file: unknown) =>
        typeof file === 'object' && file !== null && 'path' in file && typeof file.path === 'string'
          ? [file.path]
          : [],
      )
    : []
  return { name, version, tarball: filename, files: paths }
}

/**
 * Packs one package with `pnpm pack`, never `npm pack`: only pnpm rewrites `workspace:` and
 * `catalog:` versions and applies `publishConfig` (D75). The package must be built.
 * @internal
 */
export function packPackage(pkg: WorkspacePackage, outDir: string): PackedPackage {
  const { command, args, options } = packCommand(pkg, outDir)
  return packed(pkg, runCommand(command, args, options))
}

/**
 * `packPackage` beside other work: packs in `outDir` are distinct files, so several run at once.
 * @internal
 */
export async function packPackageAsync(
  pkg: WorkspacePackage,
  outDir: string,
): Promise<PackedPackage> {
  const { command, args, options } = packCommand(pkg, outDir)
  return packed(pkg, await runCommandAsync(command, args, options))
}

/**
 * Packs every package in `packages` into `outDir`.
 * @internal
 */
export function packAll(
  packages: readonly WorkspacePackage[],
  outDir: string,
): readonly PackedPackage[] {
  return packages.map((pkg) => packPackage(pkg, outDir))
}
