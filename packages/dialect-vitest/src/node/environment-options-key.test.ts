// The key of `environmentOptions` an environment's options are read from: one rule for the config
// reader and the runtime, Vitest 5.0.5's (`utils/test-helpers.ts` L49).
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readVitestConfig } from './index.ts'

test("edge-runtime's options are read from environmentOptions['edge-runtime'], as Vitest names the key", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-env-key-')))
  try {
    await writeFile(
      join(root, 'vitest.config.mjs'),
      "export default { test: { environment: 'edge-runtime', environmentOptions: { 'edge-runtime': { a: 1 }, edgeRuntime: { b: 2 } } } }\n",
    )
    const read = await readVitestConfig({ cwd: root })
    assert.deepEqual(read.projects[0]?.environment, {
      name: 'edge-runtime',
      options: { a: 1 },
      // The whole object, for a docblock environment with no options (runtime/workers/base.ts).
      resolverOptions: { 'edge-runtime': { a: 1 }, edgeRuntime: { b: 2 } },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
