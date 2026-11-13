// The sweep used by the pool and lifecycle checks, itself checked: how it reads `ps`, and that the
// process-group probe sees a live group and an empty one.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import { groupAlive, killGroup, pidsInGroup, sweep } from './sweep.ts'

describe('pidsInGroup', () => {
  it('reads the pid and group columns as macOS pads them', () => {
    const output = '    1     1\n  501   501\n  600   501\n  700   700\n'
    assert.deepEqual(pidsInGroup(output, 501), [501, 600])
    assert.deepEqual(pidsInGroup(output, 999), [])
  })

  it('reads them as Linux pads them, and ignores a header or a blank line', () => {
    const output = '  PID  PGID\n    1     1\n12345 12345\n12346 12345\n\n'
    assert.deepEqual(pidsInGroup(output, 12345), [12345, 12346])
  })

  it('never matches a pid that is only a prefix of the group', () => {
    assert.deepEqual(pidsInGroup('  10  100\n 100   10\n', 10), [100])
  })
})

describe('groupAlive and sweep', () => {
  it('see a live process group, and then an empty one once it is killed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pgid = child.pid as number
    try {
      assert.equal(groupAlive(pgid), true)
      const before = await sweep(pgid, 0)
      assert.equal(before.alive, true)
      if (before.ps !== undefined) assert.ok(before.ps.includes(pgid), 'ps lists the leader')
      killGroup(pgid)
      await once(child, 'exit')
      const after = await sweep(pgid)
      assert.equal(after.alive, false)
      if (after.ps !== undefined) assert.deepEqual(after.ps, [])
    } finally {
      killGroup(pgid)
    }
  })

  it('see a group that never existed as empty', () => {
    assert.equal(groupAlive(2 ** 22 - 3), false)
  })
})
