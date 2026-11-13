// `provino jest --collectTests` (B23a): the results file as Jest 30.5.2 wrote it (`cli/collect-tests*`:
// the recorder always passes `--json`), and the text tree, which no recording holds, against a live
// Jest 30.5.2 on the same tree. Nothing may run: not a test body, not a global setup.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JEST, noColorEnv } from './live-jest.ts'
import { type Json, normalizedJson } from './mask.ts'
import { loadFixture, type Materialized, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const RESULTS = '.harness-out/jest.json'
const TRANSFORMER = new URL('../../harness/src/jest-transform.ts', import.meta.url).pathname

/** Real Jest 30.5.2 in `cwd`: its exit code and both streams. */
function liveJest(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, ...args], {
      cwd,
      env: noColorEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The text with each file's block in a fixed order (Jest prints files as they finish). */
function blocks(text: string, root: string): { files: string[]; summary: string } {
  const plain = text.replaceAll(root, '<root>')
  const at = plain.indexOf('\nTest suites:')
  const head = at === -1 ? plain : plain.slice(0, at + 1)
  return {
    files: head
      .split(/^(?=<root>)/m)
      .filter((block) => block !== '')
      .toSorted(),
    summary: at === -1 ? '' : plain.slice(at),
  }
}

async function withFixture<T>(
  id: string,
  body: (project: Materialized, argv: readonly string[]) => Promise<T>,
): Promise<T> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const argv = (fixture.manifest.run?.argv?.jest ?? []).filter((arg) => arg !== '--useStderr')
    return await body(project, argv)
  } finally {
    await project.dispose()
  }
}

describe('provino jest --collectTests --json writes what Jest 30.5.2 wrote', () => {
  for (const [id, what] of [
    ['cli/collect-tests', 'nested describes, skip, todo, each and a focused file'],
    ['cli/collect-tests-name', '-t deselects tests: pending, with a todo kept'],
    ['cli/collect-tests-load-error', 'a file that fails to import is a runtime error'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        await mkdir(join(project.root, '.harness-out'), { recursive: true })
        const argv = fixture.manifest.run?.argv?.jest ?? []
        const ended = await spawnCli(
          [
            'jest',
            `--config=${join(project.root, 'jest.config.json')}`,
            '--ci',
            ...argv,
            '--json',
            `--outputFile=${RESULTS}`,
          ],
          { cwd: project.root },
        )
        const run = fixture.manifest.run
        const golden = fixture.golden.observed
        assert.equal(ended.code, golden?.exitCode, ended.stderr)
        const kept = ended.stderr
          .split('\n')
          .filter((line) => new RegExp(run?.keepLines ?? '.').test(line))
          .join('\n')
        assert.equal(kept, golden?.stderr)
        const raw = JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json
        const observed = normalizedJson(raw, {
          roots: [project.root],
          timeKeys: run?.timeKeys ?? [],
          mask: run?.mask,
        })
        assert.deepEqual(observed, golden?.json?.[RESULTS])
      } finally {
        await project.dispose()
      }
    })
  }
})

describe('provino jest --collectTests prints the tree Jest 30.5.2 prints', () => {
  for (const id of [
    'cli/collect-tests',
    'cli/collect-tests-name',
    'cli/collect-tests-load-error',
  ]) {
    it(`${id}: the same files, trees, summary and exit code`, async () => {
      await withFixture(id, async (project, argv) => {
        await writeFile(
          join(project.root, 'jest.live.json'),
          JSON.stringify({
            ...(JSON.parse(
              await readFile(join(project.root, 'jest.config.json'), 'utf8'),
            ) as object),
            transform: { '\\.[cm]?ts$': TRANSFORMER },
          }),
        )
        const live = await liveJest(project.root, [
          '--no-cache',
          '--ci',
          '-c',
          'jest.live.json',
          ...argv,
        ])
        const ours = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci', ...argv],
          { cwd: project.root },
        )
        assert.equal(ours.code, live.code, ours.stderr)
        const expected = blocks(live.stdout, project.root)
        const actual = blocks(ours.stdout, project.root)
        assert.ok(expected.files.length > 0, live.stdout)
        assert.deepEqual(actual.summary, expected.summary)
        // A load error's text is the runner's own message (its code frame, frames and paths); the
        // recording above holds that, so here only its first line is compared.
        const head = (block: string): string =>
          block
            .split('\n')
            .slice(0, id.endsWith('error') ? 2 : undefined)
            .join('\n')
        assert.deepEqual(actual.files.map(head), expected.files.map(head))
      })
    })
  }

  it('says "No tests found." on stdout and exits 0, as Jest does, with --json too', async () => {
    await withFixture('cli/collect-tests', async (project) => {
      const config = join(project.root, 'none.config.json')
      await writeFile(
        config,
        JSON.stringify({ rootDir: project.root, testMatch: ['<rootDir>/none/**/*.test.ts'] }),
      )
      const live = await liveJest(project.root, ['--ci', '-c', config, '--collectTests'])
      for (const extra of [[], ['--json']]) {
        const ours = await spawnCli(
          ['jest', `--config=${config}`, '--ci', '--collectTests', ...extra],
          {
            cwd: project.root,
          },
        )
        assert.equal(ours.code, live.code, ours.stderr)
        assert.equal(ours.stdout, live.stdout)
        assert.equal(ours.stdout, 'No tests found.\n')
      }
    })
  })

  it('runs no global setup and no test body', async () => {
    await withFixture('cli/collect-tests', async (project) => {
      await writeFile(
        join(project.root, 'setup.cjs'),
        "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'setup-ran.txt'), 'yes')\n",
      )
      await writeFile(
        join(project.root, 'jest.config.json'),
        JSON.stringify({
          rootDir: project.root,
          testMatch: ['<rootDir>/**/*.test.ts'],
          globalSetup: join(project.root, 'setup.cjs'),
        }),
      )
      const ours = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci', '--collectTests'],
        { cwd: project.root },
      )
      assert.equal(ours.code, 0, ours.stderr)
      await assert.rejects(access(join(project.root, 'setup-ran.txt')))
    })
  })
})
