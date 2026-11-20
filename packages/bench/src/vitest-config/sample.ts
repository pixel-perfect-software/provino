// `pnpm bench:vitest-config sample`: B25c's check on the rebuilt sample (D28's terms), local only,
// never in CI. Three steps:
//   sample --build-manifest   pick the configs from GitHub, write oracle/sample-manifest.json
//   sample --fetch            download each repository's tarball at its commit into
//                             .refs/vitest-config-sample/repos/, and install the shared node_modules
//   sample                    read every config with Vitest's resolveConfig and with ours, each in a
//                             child process with the network off and a timeout, and compare
// Fewer than 200 readable stops the work for a report (D28). Every number is `local`.
import { runSampleCommand } from '../jest-config/sample.ts'
import { MANIFEST_PATH, repoDir, SAMPLE_DIR } from './sample-paths.ts'

/** The command. */
export function sampleCommand(args: readonly string[]): Promise<number> {
  return runSampleCommand(args, {
    name: 'vitest-config',
    paths: { SAMPLE_DIR, MANIFEST_PATH, repoDir },
    defaults: { concurrency: 4, timeoutMs: 60_000 },
    buildManifest: async (options) => (await import('./sample-manifest.ts')).buildManifest(options),
    fetch: async (log) => (await import('./sample-fetch.ts')).fetchVitestSample({ log }),
    run: async (options) => (await import('./sample-run.ts')).runSample(options),
  })
}
