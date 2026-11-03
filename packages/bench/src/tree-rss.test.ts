import assert from 'node:assert/strict'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BenchError } from './errors.ts'
import { code, scratch } from './internal/test-helpers.ts'
import {
  createProcReader,
  createPsReader,
  type ProcessEntry,
  parseProcStatus,
  parsePsOutput,
  processTree,
  startRssSampler,
  sumTreeRssMib,
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

// A /proc-shaped directory: one directory per process with a `status` file in it.
async function putProcess(root: string, pid: number, ppid: number, rssKib: number): Promise<void> {
  await mkdir(join(root, String(pid)), { recursive: true })
  await writeFile(
    join(root, String(pid), 'status'),
    `Name:\tx\nPid:\t${pid}\nPPid:\t${ppid}\nVmRSS:\t${rssKib} kB\n`,
  )
}

test('the /proc reader reads a /proc-shaped directory and skips non-process entries', async (t) => {
  const root = await scratch(t, 'bench-proc-')
  await putProcess(root, 100, 1, 2048)
  await putProcess(root, 101, 100, 4096)
  await mkdir(join(root, '102')) // exited between readdir and read: no status file
  await mkdir(join(root, 'self'))
  const failures: unknown[] = []
  const entries = await createProcReader(100, {
    procRoot: root,
    onFailure: (error) => failures.push(error),
  })()
  assert.equal(entries.length, 2)
  assert.equal(sumTreeRssMib(entries, 100), 6144 / 1024)
  assert.deepEqual(failures, [], 'a process that ended is not a failed read')
  await assert.rejects(
    createProcReader(100, { procRoot: join(root, 'missing') })(),
    code('BENCH_PROCESS_TABLE_UNAVAILABLE'),
  )
})

test('the /proc reader reads only new processes and the tree again, tick after tick', async (t) => {
  const root = await scratch(t, 'bench-proc-')
  await putProcess(root, 1, 0, 1024)
  await putProcess(root, 100, 1, 2048)
  await putProcess(root, 101, 100, 4096)
  await putProcess(root, 200, 1, 99_999) // not part of the tree
  const read = createProcReader(100, { procRoot: root })

  assert.equal(sumTreeRssMib(await read(), 100), 6144 / 1024)

  // Tick 2. A member grows, and a child of a member appears: both are seen. Process 200 is
  // rewritten as a child of the root, which only a reader that reads it again could notice.
  await putProcess(root, 101, 100, 8192)
  await putProcess(root, 102, 101, 1024)
  await putProcess(root, 200, 100, 50_000)
  const second = await read()
  assert.deepEqual(
    second.map((entry) => entry.pid).sort((a, b) => a - b),
    [100, 101, 102],
  )
  assert.equal(sumTreeRssMib(second, 100), 11_264 / 1024)

  // Tick 3. A member is gone, and so is everything that hung only from it.
  await rm(join(root, '101'), { recursive: true })
  const third = await read()
  assert.deepEqual(
    third.map((entry) => entry.pid),
    [100],
  )
  assert.equal(sumTreeRssMib(third, 100), 2)
})

test('the /proc reader stops counting a process that is no longer a descendant', async (t) => {
  const root = await scratch(t, 'bench-proc-')
  await putProcess(root, 100, 1, 2048)
  await putProcess(root, 101, 100, 4096)
  await putProcess(root, 102, 101, 1024)
  const read = createProcReader(100, { procRoot: root })
  assert.equal(sumTreeRssMib(await read(), 100), 7168 / 1024)
  // 101 exits and 102 is handed to init. 102 was a member, so it is read again and drops out.
  await rm(join(root, '101'), { recursive: true })
  await putProcess(root, 102, 1, 1024)
  assert.equal(sumTreeRssMib(await read(), 100), 2)
})

test('the /proc reader counts a failed read once and does not retry an unreadable process', async (t) => {
  const root = await scratch(t, 'bench-proc-')
  await putProcess(root, 100, 1, 2048)
  await mkdir(join(root, '300', 'status'), { recursive: true }) // a directory: EISDIR
  const failures: unknown[] = []
  const read = createProcReader(100, { procRoot: root, onFailure: (error) => failures.push(error) })

  assert.equal(sumTreeRssMib(await read(), 100), 2)
  assert.equal(failures.length, 1)
  assert.ok(failures[0] instanceof Error)

  assert.equal(sumTreeRssMib(await read(), 100), 2)
  assert.equal(failures.length, 1, 'an unreadable process outside the tree is not read again')

  // A status file with no Pid or PPid is a failed read too, not a process of unknown parent.
  await mkdir(join(root, '301'))
  await writeFile(join(root, '301', 'status'), 'Name:\tx\n')
  await read()
  assert.equal(failures.length, 2)
})

test('the /proc reader works through many processes with a bounded number of reads', async (t) => {
  const root = await scratch(t, 'bench-proc-')
  await putProcess(root, 100, 1, 1024)
  for (let pid = 101; pid < 141; pid++) await putProcess(root, pid, 100, 1024)
  const entries = await createProcReader(100, { procRoot: root, concurrency: 3 })()
  assert.equal(entries.length, 41)
  assert.equal(sumTreeRssMib(entries, 100), 41)
})

test('the ps reader runs the command once and parses its output', async (t) => {
  const dir = await scratch(t, 'bench-ps-')
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
    code('BENCH_PROCESS_TABLE_UNAVAILABLE'),
  )
})

test('a ps that hangs is stopped after the timeout instead of hanging the sampler', async (t) => {
  const dir = await scratch(t, 'bench-ps-')
  const stuckPs = join(dir, 'ps')
  await writeFile(stuckPs, '#!/bin/sh\nexec sleep 20\n')
  await chmod(stuckPs, 0o755)
  const started = performance.now()
  await assert.rejects(createPsReader(stuckPs, 150)(), code('BENCH_PROCESS_TABLE_UNAVAILABLE'))
  assert.ok(performance.now() - started < 10_000)

  // and a sampler on top of it can be stopped, with its first read in flight
  let reading = false
  const ps = createPsReader(stuckPs, 150)
  const sampler = startRssSampler(1, {
    intervalMs: 0,
    read: () => {
      reading = true
      return ps()
    },
  })
  while (!reading) await new Promise<void>((resolve) => setImmediate(resolve))
  const result = await sampler.stop()
  assert.equal(result.peakMib, undefined)
  assert.equal(result.failures, 1)
})

test('the sampler does no work at the start: the first read comes after the interval', async () => {
  let reads = 0
  const sampler = startRssSampler(100, {
    intervalMs: 3_600_000,
    read: async () => {
      reads += 1
      return []
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reads, 0)
  const result = await sampler.stop()
  assert.equal(reads, 0)
  assert.equal(result.samples, 0)
  assert.equal(result.peakMib, undefined)
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
  while (reads === 0) await new Promise<void>((resolve) => setImmediate(resolve))
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
