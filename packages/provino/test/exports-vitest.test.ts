// The Vitest dialect's command line stays out of what every command and worker loads (B25g, D115:
// `speed`): its table and cac's rebuilt parser are `@provino/dialect-vitest/node`'s, which only
// `provino vitest` imports, so neither `shared.js` (which every command and worker imports), a
// worker entry nor the bin's `cli.js` may hold their bytes. Since B27f (D187) the dialect is an
// add-on, so no file of this package holds them, and the add-on's `/node` does. Runs the built
// packages.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

/** The Vitest add-on's build, through this package's workspace link. */
const ADD_ON_DIST = fileURLToPath(
  new URL('../node_modules/@provino/dialect-vitest/dist/', import.meta.url),
)

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
  // No other file of this package holds it either: the add-on's own build does (the control).
  for (const name of readdirSync(DIST, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(DIST, name), 'utf8')
    assert.ok(!MARKERS.some((marker) => text.includes(marker)), `dist/${name} holds the Vitest CLI`)
  }
  const node = readFileSync(join(ADD_ON_DIST, 'node', 'index.js'), 'utf8')
  assert.ok(MARKERS.every((marker) => node.includes(marker)))
})
