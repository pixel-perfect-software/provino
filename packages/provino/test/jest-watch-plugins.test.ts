// `provino jest --watch` (B23c Phase 9): the `u` and `i` keys and third-party `watchPlugins`
// against the `watch/*` goldens recorded from Jest 30.5.2 (T9.11's typeahead check among them),
// played by `watch-goldens.ts` in this process and on a terminal. `jest-watch-typeahead` (a
// devDependency, D120) is linked into each project's `node_modules` from this package's, so the
// config's `watchPlugins` resolve as the recorder's did. The projects stay in the temp directory:
// a sandbox may refuse to create a repository under the checkout, and each fixture here has one.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture } from './recorded.ts'
import {
  FakeStdin,
  FakeTerminal,
  playInProcess,
  playOnTerminal,
  runJestCommand,
  SESSION_MS,
  terminalSkip,
} from './watch-goldens.ts'

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

describe('provino jest --watch keys u and i and watch plugins, on a terminal', () => {
  for (const name of IDS) {
    it(`watch/${name}`, { timeout: SESSION_MS + 30_000 }, async (t) => {
      const skip = await terminalSkip()
      if (skip !== false) return t.skip(skip)
      await playOnTerminal(await loadFixture(`watch/${name}`), PLAY)
    })
  }
})

describe('provino jest --watch with a plugin that fails after another was built', () => {
  it('ends the command with exit 1 and asks the bin to end the process, whatever the first plugin left open', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-watch-handle-')))
    try {
      await writeFile(
        join(dir, 'opens-interval.cjs'),
        'module.exports = class { constructor() { globalThis.__provinoHandle = setInterval(() => {}, 1000) } }\n',
      )
      await writeFile(
        join(dir, 'claims-u.cjs'),
        "module.exports = class ClaimsU { getUsageInfo() { return { key: 'u', prompt: 'x' } } }\n",
      )
      await writeFile(
        join(dir, 'jest.config.json'),
        JSON.stringify({
          rootDir: dir,
          watchPlugins: [join(dir, 'opens-interval.cjs'), join(dir, 'claims-u.cjs')],
        }),
      )
      const terminal = new FakeTerminal(false)
      let forced = 0
      const code = await runJestCommand(['--config', join(dir, 'jest.config.json'), '--watchAll'], {
        stdout: terminal,
        stderr: terminal,
        cwd: dir,
        env: { TERM: 'xterm-256color', NO_COLOR: '1' },
        stdin: new FakeStdin(),
        onForceExit: () => {
          forced += 1
        },
      })
      assert.equal(code, 1)
      assert.match(terminal.text, /Watch plugin configuration error/)
      assert.equal(forced, 1, 'the bin is asked to end the process')
    } finally {
      clearInterval(Reflect.get(globalThis, '__provinoHandle') as NodeJS.Timeout)
      Reflect.deleteProperty(globalThis, '__provinoHandle')
      await rm(dir, { recursive: true, force: true })
    }
  })
})
