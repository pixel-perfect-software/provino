// B25g, T11.16: `provino vitest --shard=i/n` runs the files Vitest 5.0.5's `BaseSequencer.shard`
// gives that shard (`orchestrator.shard.fallback: 'rooted-sha1-slice'`), held to `cli/vitest-shard-*`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { provinoVitest, withVitestFixture } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/vitest.json'

interface Json {
  readonly testResults: readonly { readonly name: string }[]
}

function names(json: Json, root: string): string[] {
  return json.testResults.map((file) => file.name.replace(root, '<root>')).sort()
}

describe('provino vitest --shard against Vitest 5.0.5', () => {
  for (const id of [
    'cli/vitest-shard-1-of-3',
    'cli/vitest-shard-2-of-3',
    'cli/vitest-shard-3-of-3',
  ]) {
    it(id, async () => {
      await withVitestFixture(id, async (fixture, root) => {
        const expected = fixture.golden.observed
        const ended = await provinoVitest(fixture, root, [
          '--reporter=json',
          `--outputFile=${OUTPUT}`,
        ])
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        const written = JSON.parse(await readFile(join(root, OUTPUT), 'utf8')) as Json
        assert.deepEqual(names(written, root), names(expected?.json?.[OUTPUT] as Json, '<root>'))
      })
    })
  }
})
