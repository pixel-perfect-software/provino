// B25g, T11.16 (D173): `provino vitest --reporter=json` writes Vitest 5.0.5's json document, held
// to the `cli/vitest-json-*` goldens recorded from the real runner: every key, in Vitest's order,
// under the recorder's normalization (the root, the times, each run of stack frames).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadVitestFixture, materializeVitest, provinoVitest } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/vitest.json'
const TIME_KEYS = new Set(['startTime', 'endTime', 'duration'])

/** The recorder's `json:` capture: `<root>`, `<time>` under the time keys, `<frames>` for each frame run. */
function normalized(value: unknown, root: string, key = ''): unknown {
  if (TIME_KEYS.has(key) && typeof value === 'number') return '<time>'
  if (typeof value === 'string') {
    return value.replaceAll(root, '<root>').replace(/(\n\s+at [^\n]*)+/g, '\n<frames>')
  }
  if (Array.isArray(value)) return value.map((entry) => normalized(entry, root))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v, root, k)]))
  }
  return value
}

describe('provino vitest --reporter=json against Vitest 5.0.5', () => {
  for (const id of ['cli/vitest-json-snapshot']) {
    it(id, async () => {
      const fixture = await loadVitestFixture(id)
      const expected = fixture.golden.observed
      const project = await materializeVitest(fixture)
      try {
        const ended = await provinoVitest(fixture, project.root, [
          '--reporter=json',
          `--outputFile=${OUTPUT}`,
        ])
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        const written: unknown = JSON.parse(await readFile(join(project.root, OUTPUT), 'utf8'))
        const actual = normalized(written, project.root)
        assert.deepEqual(actual, expected?.json?.[OUTPUT])
        // The bytes follow the keys' order, which deepEqual does not see.
        assert.equal(JSON.stringify(actual), JSON.stringify(expected?.json?.[OUTPUT]))
      } finally {
        await project.dispose()
      }
    })
  }
})
