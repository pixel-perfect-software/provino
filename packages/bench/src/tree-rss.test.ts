import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BenchError } from './errors.ts'
import {
  createPsReader,
  type ProcessEntry,
  parseProcStatus,
  parsePsOutput,
  processTree,
  readProcTable,
  startRssSampler,
  sumTreeRssMib,
  treeRss,
} from './tree-rss.ts'

// 100 is the root. 101 and 102 are its children, 103 is 101's child, 104 is 103's child. 200 is
// unrelated, and 201 is its child.
const table: readonly ProcessEntry[] = [
  { pid: 1, ppid: 0, rssKib: 1024 },
  { pid: 100, ppid: 1, rssKib: 2048 },
  { pid: 101, ppid: 100, rssKib: 4096 },
  { pid: 102, ppid: 100, rssKib: 1024 },
  { pid: 103, ppid: 101, rssKib: 8192 },
  { pid: 104, ppid: 103, rssKib: 512 },
  { pid: 200, ppid: 1, rssKib: 99999 },
  { pid: 201, ppid: 200, rssKib: 99999 },
]

test('the tree holds the root and all descendants, and nothing else', () => {
  const pids = processTree(table, 100).map((entry) => entry.pid)
  assert.deepEqual(
    pids.sort((a, b) => a - b),
    [100, 101, 102, 103, 104],
  )
})

test('the tree RSS is the sum over the tree, in MiB', () => {
  // 2048 + 4096 + 1024 + 8192 + 512 KiB = 15872 KiB
  assert.equal(sumTreeRssMib(table, 100), 15872 / 1024)
  assert.equal(sumTreeRssMib(table, 103), 8704 / 1024)
  assert.equal(sumTreeRssMib(table, 104), 0.5)
})

test('an exited root still counts its surviving descendants, and an unknown pid counts none', () => {
  const orphaned = table.filter((entry) => entry.pid !== 100)
  assert.equal(sumTreeRssMib(orphaned, 100), 13824 / 1024)
  assert.equal(sumTreeRssMib(table, 9999), 0)
})

test('a parent loop in the table does not hang the walk', () => {
  const loop: readonly ProcessEntry[] = [
    { pid: 10, ppid: 11, rssKib: 1024 },
    { pid: 11, ppid: 10, rssKib: 1024 },
  ]
  assert.equal(sumTreeRssMib(loop, 10), 2)
})

test('ps output parses; malformed lines are skipped', () => {
  const text = [
    '    1     0   1024',
    '  100     1   2048',
    'not a row',
    '  101   100   4096   extra',
    '',
  ].join('\n')
  assert.deepEqual(parsePsOutput(text), [
    { pid: 1, ppid: 0, rssKib: 1024 },
    { pid: 100, ppid: 1, rssKib: 2048 },
  ])
})

test('/proc status parses, with kernel threads at 0 KiB', () => {
  const status =
    'Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t4242\nPPid:\t100\nVmRSS:\t  51234 kB\n'
  assert.deepEqual(parseProcStatus(status), { pid: 4242, ppid: 100, rssKib: 51234 })
  assert.deepEqual(parseProcStatus('Name:\tkthreadd\nPid:\t2\nPPid:\t0\n'), {
    pid: 2,
    ppid: 0,
    rssKib: 0,
  })
  assert.equal(parseProcStatus('Name:\tx\n'), undefined)
})

test('readProcTable reads a /proc-shaped directory and skips non-process entries', async (t) => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'bench-proc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '100'))
  await writeFile(join(root, '100', 'status'), 'Pid:\t100\nPPid:\t1\nVmRSS:\t2048 kB\n')
  await mkdir(join(root, '101'))
  await writeFile(join(root, '101', 'status'), 'Pid:\t101\nPPid:\t100\nVmRSS:\t4096 kB\n')
  await mkdir(join(root, '102')) // exited between readdir and read: no status file
  await mkdir(join(root, 'self'))
  const entries = await readProcTable(root)
  assert.equal(entries.length, 2)
  assert.equal(sumTreeRssMib(entries, 100), 6144 / 1024)
  await assert.rejects(
    readProcTable(join(root, 'missing')),
    (error) => error instanceof BenchError && error.code === 'BENCH_PROCESS_TABLE_UNAVAILABLE',
  )
})

test('the ps reader runs the command once and parses its output', async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'bench-ps-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fakePs = join(dir, 'ps')
  await writeFile(fakePs, "#!/bin/sh\nprintf '  100     1   2048\\n  101   100   4096\\n'\n")
  await chmod(fakePs, 0o755)
  const entries = await createPsReader(fakePs)()
  assert.deepEqual(entries, [
    { pid: 100, ppid: 1, rssKib: 2048 },
    { pid: 101, ppid: 100, rssKib: 4096 },
  ])
  await assert.rejects(
    createPsReader(join(dir, 'missing'))(),
    (error) => error instanceof BenchError && error.code === 'BENCH_PROCESS_TABLE_UNAVAILABLE',
  )
})

test('treeRss reads the table once and sums the tree', async () => {
  let reads = 0
  const mib = await treeRss(100, async () => {
    reads += 1
    return table
  })
  assert.equal(reads, 1)
  assert.equal(mib, 15872 / 1024)
})

test('the sampler keeps the peak across reads and never overlaps them', async () => {
  const sizesKib = [1024, 8192, 2048, 4096]
  let active = 0
  let overlapped = false
  let reads = 0
  const sampler = startRssSampler(100, {
    intervalMs: 0,
    read: async () => {
      active += 1
      if (active > 1) overlapped = true
      // yield so an overlapping call would be visible
      await new Promise<void>((resolve) => setImmediate(resolve))
      const kib = sizesKib[Math.min(reads, sizesKib.length - 1)] ?? 0
      reads += 1
      active -= 1
      return [{ pid: 100, ppid: 1, rssKib: kib }]
    },
  })
  while (reads < sizesKib.length) await new Promise<void>((resolve) => setImmediate(resolve))
  const result = await sampler.stop()
  assert.equal(overlapped, false)
  assert.equal(result.peakMib, 8)
  assert.ok(result.samples >= sizesKib.length)
  assert.equal(result.failures, 0)
})

test('stop waits for the read in flight and sampling ends', async () => {
  let reads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const sampler = startRssSampler(100, {
    intervalMs: 0,
    read: async () => {
      reads += 1
      await gate
      return [{ pid: 100, ppid: 1, rssKib: 2048 }]
    },
  })
  const stopped = sampler.stop()
  release()
  const result = await stopped
  assert.equal(result.peakMib, 2)
  assert.equal(result.samples, 1)
  const readsAtStop = reads
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reads, readsAtStop)
})

test('failed reads are counted, and a sampler that never read the table has no peak', async () => {
  const failure = new BenchError('BENCH_PROCESS_TABLE_UNAVAILABLE', 'no ps')
  let reads = 0
  const sampler = startRssSampler(100, {
    intervalMs: 0,
    read: async () => {
      reads += 1
      throw failure
    },
  })
  while (reads < 3) await new Promise<void>((resolve) => setImmediate(resolve))
  const result = await sampler.stop()
  assert.equal(result.peakMib, undefined)
  assert.equal(result.samples, 0)
  assert.ok(result.failures >= 3)
  assert.equal(result.lastError, failure)
})
