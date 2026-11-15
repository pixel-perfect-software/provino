// `provino jest --watch` (B23c Phase 9): the `u` and `i` keys and third-party `watchPlugins`
// against the `watch/*` goldens recorded from Jest 30.5.2 (T9.11's typeahead check among them),
// played by `watch-goldens.ts` in this process and on a terminal. `jest-watch-typeahead` (a
// devDependency, D120) is linked into each project's `node_modules` from this package's, so the
// config's `watchPlugins` resolve as the recorder's did. The projects stay in the temp directory:
// a sandbox may refuse to create a repository under the checkout, and each fixture here has one.
import { describe, it } from 'node:test'
import { loadFixture } from './recorded.ts'
import { playInProcess, playOnTerminal, SESSION_MS, terminalSkip } from './watch-goldens.ts'

const PLAY = { link: ['jest-watch-typeahead'] }

const IDS = [
  'key-u',
  'key-i-failed',
  'key-i-snapshot',
  'plugin-custom',
  'plugin-key-conflict',
  'plugin-typeahead-filename',
  'plugin-typeahead-testname',
]

describe('provino jest --watch keys u and i and watch plugins, in this process', () => {
  for (const name of IDS) {
    it(`watch/${name}`, { timeout: SESSION_MS + 30_000 }, async () => {
      await playInProcess(await loadFixture(`watch/${name}`), PLAY)
    })
  }
})

describe('provino jest --watch keys u and i and watch plugins, on a terminal', async () => {
  const skip = await terminalSkip()
  for (const name of IDS) {
    it(`watch/${name}`, { skip, timeout: SESSION_MS + 30_000 }, async () => {
      await playOnTerminal(await loadFixture(`watch/${name}`), PLAY)
    })
  }
})
