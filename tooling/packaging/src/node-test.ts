// `node --test` with the shard flag in front. `provino`'s `test` script runs through this file so a
// shard can take half the package's test files: Node reads its options only up to the first test
// pattern, so `--test-shard` after the script's globs (where `pnpm` and Turborepo append their own
// arguments) is ignored and every file runs. The shard comes from `PROVINO_TEST_SHARD` (`<n>/<of>`,
// set by `test-shards.ts`, and a `turbo.json` `test` env so each shard's cache entry is its own);
// unset, every file runs.
//
//   node tooling/packaging/src/node-test.ts [node test flags…] <patterns…>
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The shard `PROVINO_TEST_SHARD` names (`<n>/<of>`), or `undefined` when it is unset or empty
 * (every file runs); anything else is refused. `runner-shard.ts` reads it the same way.
 * @internal
 */
export function shardOf(shard: string | undefined): string | undefined {
  if (shard === undefined || shard === '') return undefined
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    throw new RangeError(`PROVINO_TEST_SHARD must be <n>/<of>, got ${shard}`)
  }
  return shard
}

/**
 * The arguments for `node`: `--test`, the shard flag when there is a shard, then the rest.
 * @internal
 */
export function nodeTestArgs(
  shard: string | undefined,
  args: readonly string[],
): readonly string[] {
  const of = shardOf(shard)
  return of === undefined ? ['--test', ...args] : ['--test', `--test-shard=${of}`, ...args]
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = spawnSync(
    process.execPath,
    nodeTestArgs(process.env.PROVINO_TEST_SHARD, process.argv.slice(2)),
    { stdio: 'inherit' },
  )
  process.exitCode = result.status ?? 1
}
