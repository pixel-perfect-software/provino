// The Vitest dialect's command line stays out of what every command and worker loads (B25g, D115:
// `speed`): its table and cac's rebuilt parser are `@provino/dialect-vitest/node`'s, which only
// `provino vitest` imports. Since B27f (D187) the dialect is an add-on, so no file of this package
// holds their bytes (`shared.js`, the worker entries and the bin's `cli.js` among them), and the
// add-on's `/node` does. Runs the built packages.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'provino'
import { ADD_ON_DISTS, builtSources, DIST } from './dist.ts'

/** Text only the Vitest command line holds: two of its names and one of the table's descriptions. */
const MARKERS = ['VITEST_CLI_OPTIONS', 'cacParse', 'Base directory to scan for the test files']

test('no built file of provino holds the Vitest command line; the add-on does', () => {
  const sources = builtSources(DIST)
  for (const wanted of ['shared.js', 'cli.js']) assert.ok(sources.has(wanted), wanted)
  for (const [name, text] of sources) {
    for (const marker of MARKERS) {
      assert.ok(!text.includes(marker), `dist/${name} holds ${JSON.stringify(marker)}`)
    }
  }
  // The control: the add-on's own build has it.
  const node = readFileSync(join(ADD_ON_DISTS['dialect-vitest'] ?? '', 'node', 'index.js'), 'utf8')
  assert.ok(MARKERS.every((marker) => node.includes(marker)))
})
