// B25g, T11.16 (D173): `provino vitest --reporter=json` writes Vitest 5.0.5's json document, held
// to the `cli/vitest-json-*` goldens recorded from the real runner: every key, in Vitest's order,
// under the recorder's normalization (the root, the times, each run of stack frames).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { type Json, normalizedJson } from './mask.ts'
import { provinoVitest, withVitestFixture } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/vitest.json'
const TIME_KEYS = ['startTime', 'endTime', 'duration']

describe('provino vitest --reporter=json against Vitest 5.0.5', () => {
  for (const id of ['cli/vitest-json-snapshot']) {
    it(id, async () => {
      await withVitestFixture(id, async (fixture, root) => {
        const expected = fixture.golden.observed
        const ended = await provinoVitest(fixture, root, [
          '--reporter=json',
          `--outputFile=${OUTPUT}`,
        ])
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        const written: unknown = JSON.parse(await readFile(join(root, OUTPUT), 'utf8'))
        const actual = normalizedJson(written as Json, { roots: [root], timeKeys: TIME_KEYS })
        assert.deepEqual(actual, expected?.json?.[OUTPUT])
        // The bytes follow the keys' order, which deepEqual does not see.
        assert.equal(JSON.stringify(actual), JSON.stringify(expected?.json?.[OUTPUT]))
      })
    })
  }
})
