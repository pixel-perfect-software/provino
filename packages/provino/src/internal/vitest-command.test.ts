// B25g (D183): `provino vitest` in process: what it refuses by name before it reads a config.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NeutralProject } from '@provino/types'
import { afterAll, beforeAll, describe, it } from 'provino'
import { chooseProjects, runVitestCommand } from './vitest-command.ts'

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
  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-command-')))
  })
  afterAll(() => rm(cwd, { recursive: true, force: true }))

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

describe('provino vitest file filters', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-filter-word-')))
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n')
    await writeFile(join(root, 'vitest.config.ts'), 'export default { test: { globals: true } }\n')
    await writeFile(join(root, 'Alpha.test.ts'), "it('a', () => {})\n")
    await writeFile(join(root, 'beta.test.ts'), "it('b', () => {})\n")
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  it('match the path from the root, so a word of the root selects no file (project.ts L413-L423)', async () => {
    const ended = await runVitest(['run', 'filter-word'], root)
    assert.equal(ended.code, 1, head(ended.stderr))
    assert.ok(/No test files found/.test(ended.stderr), head(ended.stderr))
  })

  it('match without regard to case', async () => {
    const ended = await runVitest(
      ['run', 'ALPHA', '--reporter=json', '--outputFile=out.json'],
      root,
    )
    assert.equal(ended.code, 0, head(ended.stderr))
    const json = JSON.parse(await readFile(join(root, 'out.json'), 'utf8')) as {
      testResults: { name: string }[]
    }
    assert.deepEqual(
      json.testResults.map((result) => result.name),
      [join(root, 'Alpha.test.ts')],
    )
  })

  it('sets VITEST_MODE for the workers only, as pool.ts L260 does', async () => {
    delete process.env.VITEST_MODE
    const ended = await runVitest(['run', 'beta'], root)
    assert.equal(ended.code, 0, head(ended.stderr))
    assert.equal(process.env.VITEST, 'true')
    assert.equal(process.env.VITEST_MODE, undefined)
  })

  it('refuse a file:line filter with a printed error', async () => {
    const ended = await runVitest(['run', 'Alpha.test.ts:1'], root)
    assert.equal(ended.code, 1)
    assert.ok(/Alpha\.test\.ts:1 is not supported/.test(ended.stderr), head(ended.stderr))
    assert.ok(!/ORCH_NOT_IMPLEMENTED/.test(ended.stderr), head(ended.stderr))
  })
})

describe('provino vitest reporter options', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-reporters-')))
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n')
    await writeFile(join(root, 'a.test.ts'), "it('a', () => {})\n")
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

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

describe('--project', () => {
  const projects = ['Web', 'api', 'api-e2e'].map((name) => ({ name }) as NeutralProject)
  const chosen = (patterns: unknown): string[] =>
    chooseProjects(projects, patterns).map((project) => project.name)

  it('matches names without regard to case, with * wildcards (wildcardPatternToRegExp)', () => {
    assert.deepEqual(chosen('web'), ['Web'])
    assert.deepEqual(chosen(['API*']), ['api', 'api-e2e'])
  })

  it('leaves out a name a ! pattern matches (isExcludedByProjectFilter)', () => {
    assert.deepEqual(chosen(['!api*']), ['Web'])
    assert.deepEqual(chosen(['api*', '!api-e2e']), ['api'])
  })

  it('says so when no project is left', () => {
    assert.throws(() => chosen(['nope']), /No projects matched the filter "nope"\./)
  })
})
