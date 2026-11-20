// B25g (D183): `provino vitest` in process: what it refuses by name before it reads a config.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

describe('provino vitest reporter options', () => {
  let root = ''
  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-reporters-')))
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n')
    await writeFile(join(root, 'a.test.ts'), "it('a', () => {})\n")
  })
  after(() => rm(root, { recursive: true, force: true }))

  const configWith = (reporters: unknown): Promise<void> =>
    writeFile(
      join(root, 'vitest.config.ts'),
      `export default ${JSON.stringify({ test: { globals: true, reporters, outputFile: 'shared.json' } })}\n`,
    )

  it("['json', { outputFile }] writes there, over test.outputFile (JsonReporter's options first)", async () => {
    await configWith([['json', { outputFile: 'own.json' }]])
    const ended = await runVitest(['run'], root)
    assert.equal(ended.code, 0, head(ended.stderr))
    assert.match(ended.stdout, /JSON report written to .*own\.json/)
    const json = JSON.parse(await readFile(join(root, 'own.json'), 'utf8')) as {
      numTotalTests: number
    }
    assert.equal(json.numTotalTests, 1)
  })

  it('refuses options on a text reporter by name (parked, D183)', async () => {
    await configWith([['verbose', { summary: false }]])
    const ended = await runVitest(['run'], root)
    assert.equal(ended.code, 1)
    assert.ok(
      /the reporter "verbose" takes no options here \(parked \(D183\)\)/.test(ended.stderr),
      head(ended.stderr),
    )
  })
})
