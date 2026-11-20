// The Vitest dialect's command line stays out of what every command and worker loads (B25g, D115:
// `speed`): its table and cac's rebuilt parser are `@provino/dialect-vitest/node`'s, which only
// `provino vitest` imports, so neither `shared.js` (which every command and worker imports), a
// worker entry nor the bin's `cli.js` may hold their bytes. Runs the built package.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

/** Text only the Vitest command line holds: two of its names and one of the table's descriptions. */
const MARKERS = ['VITEST_CLI_OPTIONS', 'cacParse', 'Base directory to scan for the test files']

test('shared.js, the worker entries and cli.js hold none of the Vitest command line', () => {
  const files = [
    'shared.js',
    'cli.js',
    ...readdirSync(join(DIST, 'worker'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `worker/${name}`),
  ]
  for (const name of files) {
    const text = readFileSync(join(DIST, name), 'utf8')
    for (const marker of MARKERS) {
      assert.ok(!text.includes(marker), `dist/${name} holds ${JSON.stringify(marker)}`)
    }
  }
  // The control: the build still has it, in a chunk of its own.
  const all = readdirSync(DIST)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(DIST, name), 'utf8'))
  assert.ok(all.some((text) => MARKERS.every((marker) => text.includes(marker))))
})
