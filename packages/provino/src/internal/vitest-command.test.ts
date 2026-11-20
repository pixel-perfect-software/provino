// B25g (D183): `provino vitest` in process: what it refuses by name before it reads a config.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runVitestCommand } from './vitest-command.ts'

/** Runs the command with in-memory streams. */
async function runVitest(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runVitestCommand(args, {
    stdout: {
      write: (text: string) => {
        stdout += text
      },
    },
    stderr: {
      write: (text: string | Uint8Array) => {
        stderr += String(text)
        return true
      },
    } as NodeJS.WritableStream,
    cwd,
    env: {},
  })
  return { code, stdout, stderr }
}

/** The first 300 characters, so a run that should not have started prints little. */
const head = (text: string): string => text.slice(0, 300)

describe('provino vitest refuses by name', () => {
  // An empty directory: a command that runs anyway finds no test file.
  let cwd = ''
  before(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-command-')))
  })
  after(() => rm(cwd, { recursive: true, force: true }))

  it('vitest list (parked, D183): it runs no suite', async () => {
    const ended = await runVitest(['list'], cwd)
    assert.equal(ended.code, 1, head(ended.stderr))
    assert.ok(
      /vitest list is not supported \(parked \(D183\)\)/.test(ended.stderr),
      head(ended.stderr),
    )
    assert.equal(ended.stdout, '')
  })
})
