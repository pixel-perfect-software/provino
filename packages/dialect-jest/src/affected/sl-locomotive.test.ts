// T9.16: `sl` as the steam locomotive. Jest remembers it for the process (`sl.ts` L18-L21); the
// provider remembers it for its own life, which is the coordinator's, and the first locomotive
// stops the other `sl root` probes still running. A fake `sl` on PATH logs its pid and directory:
// in `r0` it draws (an escape code) at once, elsewhere it waits without printing, so only the
// first detection can end those. Every pid it logged must be gone when the lookup returns.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, test } from 'provino'
import { jestChangedFiles } from './index.ts'

// The probe in `r0` draws only once all five have logged themselves (a barrier on the log, kept in
// the fake, so the test itself waits on nothing): every probe has started before the first
// detection, whatever the machine's timing, and only that detection can end the other four.
const FAKE = `#!/bin/sh
printf '%s %s\\n' "$$" "$PWD" >> "$PROVINO_FAKE_LOG"
case "$PWD" in
  */r0)
    while [ "$(wc -l < "$PROVINO_FAKE_LOG")" -lt "$PROVINO_FAKE_PROBES" ]; do sleep 0.01; done
    printf '\\033[0m choo choo' ;;
esac
exec sleep 30
`

let base = ''
let log = ''
const saved = { ...process.env }

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'provino-sl-')))
  const bin = join(base, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'sl'), FAKE)
  await chmod(join(bin, 'sl'), 0o755)
  log = join(base, 'calls.log')
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    PROVINO_FAKE_LOG: log,
    PROVINO_FAKE_PROBES: '5',
    GIT_CEILING_DIRECTORIES: base,
  })
})

afterAll(async () => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
  Object.assign(process.env, saved)
  await rm(base, { recursive: true, force: true })
})

async function calls(): Promise<readonly { pid: number; dir: string }[]> {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [pid = '', ...dir] = line.split(' ')
      return { pid: Number(pid), dir: dir.join(' ') }
    })
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: unknown }).code === 'ESRCH'
  }
}

test('the first locomotive stops the other probes, and none is looked for again', {
  timeout: 60_000,
}, async () => {
  const roots: string[] = []
  for (let index = 0; index < 5; index++) {
    roots.push(join(base, `r${index}`))
    await mkdir(join(base, `r${index}`))
  }
  // Five at once (the limiter's limit): the four silent probes end only by the first detection.
  const first = await jestChangedFiles({ roots })
  assert.deepEqual(first.repos.sl, [])
  const probed = await calls()
  assert.equal(probed.length, 5)
  for (const { pid } of probed) assert.ok(gone(pid), `sl ${pid} was left running`)

  // The provider lives on: a second lookup starts no `sl` at all.
  await writeFile(log, '')
  const second = await jestChangedFiles({ roots: [join(base, 'r1')] })
  assert.deepEqual(second.repos.sl, [])
  assert.deepEqual(await calls(), [])
})
