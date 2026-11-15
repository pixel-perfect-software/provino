import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import JestWatchDonePlugin, { WATCH_DONE_ENV } from './jest-watch-done.ts'

test('the plugin appends a line at every end of a run, and has no key or usage row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-done-'))
  try {
    const file = path.join(dir, 'done.txt')
    const plugin = new JestWatchDonePlugin({ config: { outputFile: file } })
    const listeners: ((results: unknown) => void)[] = []
    plugin.apply({ onTestRunComplete: (listener) => listeners.push(listener) })
    assert.equal(listeners.length, 1)
    listeners[0]?.({})
    listeners[0]?.({})
    assert.equal(await readFile(file, 'utf8'), 'done\ndone\n')
    // Jest reads a plugin's key from `getUsageInfo`; this one has none, so the usage is unchanged.
    assert.equal('getUsageInfo' in plugin, false)
    assert.equal('run' in plugin, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the file comes from the config, else the environment, and a plugin with neither throws', () => {
  const saved = process.env[WATCH_DONE_ENV]
  try {
    process.env[WATCH_DONE_ENV] = '/nowhere/done.txt'
    assert.ok(new JestWatchDonePlugin({}))
    delete process.env[WATCH_DONE_ENV]
    assert.throws(() => new JestWatchDonePlugin(), /needs a file to write/)
    assert.throws(() => new JestWatchDonePlugin({ config: { outputFile: '' } }), /needs a file/)
  } finally {
    if (saved === undefined) delete process.env[WATCH_DONE_ENV]
    else process.env[WATCH_DONE_ENV] = saved
  }
})
