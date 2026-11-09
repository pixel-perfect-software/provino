// Runs a corpus check's child script in its own node process and reads back the JSON it wrote.
// Some corpus runs can't share the harness's test process: they fake its global timers, or raise
// uncaught exceptions and rejections that `node:test` would take for its own.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '../run-process.ts'

const TIMEOUT_MS = 60_000

/**
 * Runs `node --conditions=provino-source <nodeFlags> <script> <args> <out>` in `cwd` and parses
 * the file `<out>` it wrote. `label` names the run in an error. Rejects with the child's output
 * when it exits non-zero or times out.
 * @internal
 */
export async function runChildJson<T>(
  script: string,
  args: readonly string[],
  cwd: string,
  nodeFlags: readonly string[],
  label: string,
): Promise<T> {
  const work = await mkdtemp(path.join(tmpdir(), 'provino-corpus-child-'))
  const out = path.join(work, 'out.json')
  try {
    const result = await runProcess(
      process.execPath,
      ['--conditions=provino-source', ...nodeFlags, script, ...args, out],
      { cwd, env: process.env, timeoutMs: TIMEOUT_MS },
    )
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `the corpus child failed for ${label}, exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}:\n${result.output}`,
      )
    }
    return JSON.parse(await readFile(out, 'utf8')) as T
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
