// `pnpm bench:jest-config sample`: T11.6's check on the rebuilt sample (D28), local only, never in
// CI. Three steps:
//   sample --build-manifest   pick the configs from GitHub, write oracle/sample-manifest.json
//   sample --fetch            download each repository's tarball at its commit into
//                             .refs/jest-config-sample/repos/, and install the shared node_modules
//   sample                    read every config with real jest-config and with ours, each in a
//                             child process with the network off and a timeout, and compare
// The bar: every config jest-config can read is equal on the 55 keys (`compare.ts`); fewer than
// 200 readable stops the work for a report (D28). Every number is `local`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { type SamplePaths, samplePaths } from './sample-paths.ts'

/** What differs between the Jest sample's command and the Vitest sample's. */
export interface SampleSpec {
  /** `jest-config` or `vitest-config`: the `bench:` script's name. */
  readonly name: string
  readonly paths: SamplePaths
  /** What `--concurrency` and `--timeout-ms` default to. */
  readonly defaults: { readonly concurrency: number; readonly timeoutMs: number }
  readonly buildManifest: (options: {
    readonly cacheDir: string
    readonly log: (line: string) => void
  }) => Promise<{ readonly repos: readonly { readonly configs: readonly unknown[] }[] }>
  readonly fetch: (log: (line: string) => void) => Promise<number>
  readonly run: (options: {
    readonly log: (line: string) => void
    readonly concurrency: number
    readonly timeoutMs: number
    readonly only?: string
  }) => Promise<number>
}

/** The command, for either sample. */
export async function runSampleCommand(args: readonly string[], spec: SampleSpec): Promise<number> {
  let values: {
    'build-manifest'?: boolean
    fetch?: boolean
    only?: string
    concurrency?: string
    'timeout-ms'?: string
  }
  try {
    values = parseArgs({
      args: [...args],
      options: {
        'build-manifest': { type: 'boolean' },
        fetch: { type: 'boolean' },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }).values
  } catch (error) {
    process.stderr.write(
      `bench:${spec.name} sample: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
  const log = (line: string) => process.stdout.write(`${line}\n`)
  const { MANIFEST_PATH, SAMPLE_DIR: sampleDir } = spec.paths
  if (values['build-manifest']) {
    const manifest = await spec.buildManifest({ cacheDir: `${sampleDir}api-cache`, log })
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    const configs = manifest.repos.reduce((sum, repo) => sum + repo.configs.length, 0)
    log(`wrote ${MANIFEST_PATH}: ${manifest.repos.length} repositories, ${configs} configs`)
    return 0
  }
  if (values.fetch) return spec.fetch(log)
  const concurrency =
    values.concurrency === undefined ? spec.defaults.concurrency : Number(values.concurrency)
  const timeoutMs =
    values['timeout-ms'] === undefined ? spec.defaults.timeoutMs : Number(values['timeout-ms'])
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    process.stderr.write(
      `bench:${spec.name} sample: --concurrency and --timeout-ms need whole numbers ≥ 1\n`,
    )
    return 2
  }
  return spec.run({
    log,
    concurrency,
    timeoutMs,
    ...(values.only === undefined ? {} : { only: values.only }),
  })
}

/** The command. */
export function sampleCommand(args: readonly string[]): Promise<number> {
  return runSampleCommand(args, {
    name: 'jest-config',
    paths: samplePaths('jest'),
    defaults: { concurrency: 6, timeoutMs: 30_000 },
    buildManifest: async (options) => (await import('./sample-manifest.ts')).buildManifest(options),
    fetch: async (log) => {
      const { fetchSample, SHARED_PACKAGES } = await import('./sample-fetch.ts')
      return fetchSample({
        log,
        name: 'jest',
        paths: samplePaths('jest'),
        sharedPackages: SHARED_PACKAGES,
      })
    },
    run: async (options) => (await import('./sample-run.ts')).runSample(options),
  })
}
