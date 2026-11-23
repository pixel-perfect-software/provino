// `provino run` on this checkout's built bin with the shard flag. A split package's `test` script
// (`testScript` in `dogfood.ts`) runs its Provino half through this file, as it runs its node:test
// half through `node-test.ts`, so each CI shard takes its share of both halves and every file runs in
// exactly one shard. The shard comes from `PROVINO_TEST_SHARD` (`<n>/<of>`, set by `test-shards.ts`
// and a `turbo.json` `test` env); unset, every file runs. The bin is found from this file, so it
// runs in the package directory (discovery finds the package's own config) whatever that is.
//
//   node tooling/packaging/src/runner-shard.ts [provino run flags…]
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RUNNER_BIN, SHARD_VARIABLE, shardOf } from './dogfood.ts'

/** This checkout's built bin (`RUNNER_BIN`), from this file. */
const BIN = fileURLToPath(new URL(`../../../${RUNNER_BIN}`, import.meta.url))

/**
 * The arguments for `node`: the bin, `run`, `--shard=<n>/<of>` when there is a shard, then the rest.
 * @internal
 */
export function runnerArgs(shard: string | undefined, args: readonly string[]): readonly string[] {
  const of = shardOf(shard)
  return [BIN, 'run', ...(of === undefined ? [] : [`--shard=${of}`]), ...args]
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = spawnSync(
    process.execPath,
    runnerArgs(process.env[SHARD_VARIABLE], process.argv.slice(2)),
    { stdio: 'inherit' },
  )
  process.exitCode = result.status ?? 1
}
