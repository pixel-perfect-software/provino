// `pnpm bench:vitest-config sample`: B25c's check on the rebuilt sample (D28's terms), local only,
// never in CI. Three steps:
//   sample --build-manifest   pick the configs from GitHub, write oracle/sample-manifest.json
//   sample --fetch            download each repository's tarball at its commit into
//                             .refs/vitest-config-sample/repos/, and install the shared node_modules
//   sample                    read every config with Vitest's resolveConfig and with ours, each in a
//                             child process with the network off and a timeout, and compare
// Fewer than 200 readable stops the work for a report (D28). Every number is `local`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
      `bench:vitest-config sample: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
  const log = (line: string) => process.stdout.write(`${line}\n`)
  if (values['build-manifest']) {
    const { buildManifest } = await import('./sample-manifest.ts')
    const manifest = await buildManifest({ cacheDir: `${SAMPLE_DIR}api-cache`, log })
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
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
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency)
  const timeoutMs = values['timeout-ms'] === undefined ? 60_000 : Number(values['timeout-ms'])
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    process.stderr.write(
      'bench:vitest-config sample: --concurrency and --timeout-ms need whole numbers ≥ 1\n',
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
