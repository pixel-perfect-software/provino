import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { HarnessError } from './errors.ts'
import { isRecord } from './internal/guards.ts'

/**
 * An installed runner package: its version and its bin script.
 * @public
 */
export interface RunnerPackage {
  readonly version: string
  /** Absolute path of the bin script: a real file, never a `.bin` shim. */
  readonly bin: string
  /** The bin's path inside the package, e.g. `bin/jest.js`. */
  readonly binInPackage: string
}

/** A directory path (or `file:` URL text) becomes something `createRequire` resolves from. */
function anchorOf(from: string | URL): string | URL {
  if (from instanceof URL) return from
  return from.startsWith('file:') ? new URL(from) : path.join(path.resolve(from), path.sep)
}

function binField(bin: unknown, name: string): string | undefined {
  if (typeof bin === 'string') return bin
  const entry = isRecord(bin) ? bin[name] : undefined
  return typeof entry === 'string' ? entry : undefined
}

/**
 * Finds a runner's package (`jest`, `vitest`) the way `require` would from `from`: a directory
 * path, or a URL such as `new URL(import.meta.url)`. Throws `HARNESS_RUNNER_FAILED` if the package
 * isn't installed there or its `package.json` has no version or no bin named like the package.
 * @public
 */
export function resolveRunnerPackage(name: string, from: string | URL): RunnerPackage {
  let manifestPath: string
  let manifest: unknown
  try {
    manifestPath = createRequire(anchorOf(from)).resolve(`${name}/package.json`)
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new HarnessError(
      'HARNESS_RUNNER_FAILED',
      `${name} is not installed for ${String(from)}`,
      {
        cause,
      },
    )
  }
  const version = isRecord(manifest) ? manifest.version : undefined
  const binInPackage = isRecord(manifest) ? binField(manifest.bin, name) : undefined
  if (typeof version !== 'string') {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `${manifestPath} has no version`, {
      path: manifestPath,
    })
  }
  if (binInPackage === undefined) {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `${manifestPath} has no "${name}" bin`, {
      path: manifestPath,
    })
  }
  return {
    version,
    bin: path.resolve(path.dirname(manifestPath), binInPackage),
    binInPackage: path.normalize(binInPackage),
  }
}
