// `pnpm bench:jest-config sample`: T11.6's check on the rebuilt sample (D28), local only, never in
// CI. Three steps:
//   sample --build-manifest   pick the configs from GitHub, write oracle/sample-manifest.json
//   sample --fetch            download each repository's tarball at its commit into
//                             .refs/jest-config-sample/repos/, and install the shared node_modules
//   sample                    read every config with real jest-config and with ours, each in a
//                             child process with the network off and a timeout, and compare
// The bar: every config jest-config can read is equal on the 55 keys (`compare.ts`); fewer than
// 200 readable stops the work for a report (D28). Every number is `local`.
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { MANIFEST_PATH, SAMPLE_DIR } from './sample-paths.ts'

/** The command. */
export async function sampleCommand(args: readonly string[]): Promise<number> {
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
      `bench:jest-config sample: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
  const log = (line: string) => process.stdout.write(`${line}\n`)
  if (values['build-manifest']) {
    const { buildManifest } = await import('./sample-manifest.ts')
    const manifest = await buildManifest({ cacheDir: `${SAMPLE_DIR}api-cache`, log })
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    const configs = manifest.repos.reduce((sum, repo) => sum + repo.configs.length, 0)
    log(`wrote ${MANIFEST_PATH}: ${manifest.repos.length} repositories, ${configs} configs`)
    return 0
  }
  if (values.fetch) {
    const { fetchSample } = await import('./sample-fetch.ts')
    return fetchSample({ log })
  }
  const { runSample } = await import('./sample-run.ts')
  const concurrency = values.concurrency === undefined ? 6 : Number(values.concurrency)
  const timeoutMs = values['timeout-ms'] === undefined ? 30_000 : Number(values['timeout-ms'])
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    process.stderr.write(
      'bench:jest-config sample: --concurrency and --timeout-ms need whole numbers ≥ 1\n',
    )
    return 2
  }
  return runSample({
    log,
    concurrency,
    timeoutMs,
    ...(values.only === undefined ? {} : { only: values.only }),
  })
}
