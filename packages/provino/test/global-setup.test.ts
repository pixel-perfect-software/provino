// T9.15: `provino jest` runs the project's globalSetup and globalTeardown in the coordinator, as
// Jest 30.5.2 does. Against black-box goldens recorded from the real runner
// (`cli/global-setup-{order,globals,throws,projects}`: the order of setup, test and teardown, what
// the teardown sees of `globalThis` that a test in a worker does not, a throwing setup's exit code
// and message, two projects), and against real Jest run beside it for the transformed setup files
// (babel-jest and ts-jest, which the harness has no recorder for).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadFixture, materialize, underRoot } from './recorded.ts'
import { spawnCli } from './support.ts'

/** What a fixture's golden says its run wrote to `name`. */
function recordedFile(
  golden: Awaited<ReturnType<typeof loadFixture>>['golden'],
  name: string,
): string {
  const text = golden.observed?.files?.[name]
  assert.equal(typeof text, 'string', `the golden captured ${name}`)
  return String(text)
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

describe('provino jest against the recorded Jest 30.5.2 runs', () => {
  for (const [id, file] of [
    ['cli/global-setup-order', 'order.txt'],
    ['cli/global-setup-globals', 'seen.txt'],
  ] as const) {
    it(`${id}: ${file} and the exit code are Jest's`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`],
          {
            cwd: project.root,
          },
        )
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        assert.equal(
          await readOrEmpty(join(project.root, file)),
          recordedFile(fixture.golden, file),
        )
        assert.ok(
          !/globalSetup|globalTeardown/.test(ended.stderr),
          `no warning that a global hook is not applied:\n${ended.stderr}`,
        )
      } finally {
        await project.dispose()
      }
    })
  }

  it('cli/global-setup-throws: no test file runs, and the exit code and message are Jest’s', async () => {
    const fixture = await loadFixture('cli/global-setup-throws')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(['jest', `--config=${join(project.root, 'jest.config.json')}`], {
        cwd: project.root,
      })
      assert.equal(ended.signal, null)
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const printed = underRoot(ended.stderr, project.root)
      for (const line of String(fixture.golden.observed?.stderr).split('\n')) {
        assert.ok(printed.includes(line), `stderr has "${line}":\n${printed}`)
      }
      assert.ok(!/^(PASS|FAIL) /m.test(printed), `no test file ran:\n${printed}`)
      assert.ok(!/unexpected error/i.test(printed), `it is not an internal error:\n${printed}`)
    } finally {
      await project.dispose()
    }
  })

  it('cli/global-setup-projects: setup project by project, and the teardowns in the same order', async () => {
    const fixture = await loadFixture('cli/global-setup-projects')
    const project = await materialize(fixture)
    try {
      // The recorder reserves `projects`, so the recording named them on the command line; the same
      // two projects as a config key (`provino jest` refuses the flag).
      const config = join(project.root, 'jest.config.json')
      await writeFile(
        config,
        JSON.stringify({ rootDir: project.root, projects: ['<rootDir>/p1', '<rootDir>/p2'] }),
      )
      const ended = await spawnCli(['jest', `--config=${config}`], { cwd: project.root })
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      assert.equal(
        await readOrEmpty(join(project.root, 'order.txt')),
        recordedFile(fixture.golden, 'order.txt'),
      )
    } finally {
      await project.dispose()
    }
  })

  // Jest's reporters print the summary inside `scheduleTests`, and `runJest` runs the teardown
  // after it: what a teardown prints, or fails with, comes below the totals. Held in order.
  for (const [id, keep] of [
    ['cli/global-teardown-output', /^(Test Suites|Tests):|^teardown ran/],
    [
      'cli/global-teardown-throws',
      /^(Test Suites|Tests):|^(?!\s*at ).*(globalTeardown|teardown failed)/,
    ],
  ] as const) {
    it(`${id}: the totals come first, then the teardown's output or its failure, and the exit code is Jest's`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`],
          { cwd: project.root },
        )
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        const printed = underRoot(ended.stderr, project.root)
          .split('\n')
          .filter((line) => keep.test(line))
        assert.deepEqual(printed, String(fixture.golden.observed?.stderr).split('\n'))
      } finally {
        await project.dispose()
      }
    })
  }

  // The recorder reserves `projects`, so these recordings named them on the command line: the same
  // projects, as a key of the config the fixture's own overlay (the root's hooks) is already in.
  for (const [id, projects] of [
    ['cli/global-setup-root-projects', ['p1', 'p2']],
    ['cli/global-setup-sequence', ['a', 'b', 'c']],
  ] as const) {
    it(`${id}: order.txt is Jest's: the root's hook after the projects', in the sequenced order, with the first project's config`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const config = join(project.root, 'jest.config.json')
        const base = JSON.parse(await readFile(config, 'utf8')) as Record<string, unknown>
        await writeFile(
          config,
          JSON.stringify({ ...base, projects: projects.map((name) => `<rootDir>/${name}`) }),
        )
        const ended = await spawnCli(['jest', `--config=${config}`], { cwd: project.root })
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        assert.equal(
          await readOrEmpty(join(project.root, 'order.txt')),
          recordedFile(fixture.golden, 'order.txt'),
        )
      } finally {
        await project.dispose()
      }
    })
  }
})

// ---- transformed setup files, against real Jest run beside it ----

const FIXTURE: string = fileURLToPath(
  new URL('../../transform/fixtures/global-setup', import.meta.url),
)
const JEST: string = createRequire(join(FIXTURE, 'x.js')).resolve('jest/bin/jest')

const temps: string[] = []
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** What a run of the fixture wrote to its log. */
async function logOf(run: (log: string) => Promise<{ code: number | null; stderr: string }>) {
  const dir = await mkdtemp(join(tmpdir(), 'provino-global-setup-'))
  temps.push(dir)
  const log = join(dir, 'log.txt')
  const { code, stderr } = await run(log)
  return { code, stderr, log: await readOrEmpty(log) }
}

function jestRunWith(
  log: string,
  config: string,
  flags: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(process.execPath, [JEST, '-c', config, '--no-cache', '--ci', ...flags], {
      cwd: FIXTURE,
      env: { ...process.env, GLOBAL_SETUP_LOG: log, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

function jestRun(config: string) {
  return logOf((log) => jestRunWith(log, config, [], {}))
}

function provinoRun(config: string) {
  return logOf(async (log) => {
    const ended = await spawnCli(['jest', '-c', config, '--no-cache', '--ci'], {
      cwd: FIXTURE,
      env: { GLOBAL_SETUP_LOG: log },
    })
    return { code: ended.code, stderr: ended.stderr }
  })
}

describe('a setup file a Jest transformer handles', () => {
  it('in band, the test sees the global the setup set, as it does under Jest’s in-band run; the teardown always does', async () => {
    // Jest's own answer, live: in band, jest-environment-node copies the main process's globals
    // into the test's context. `--detectOpenHandles` runs both runners in band (Provino's inline
    // pool); `-i` still starts a worker here, since mapping it to the inline pool is T9.9's.
    const env = { LOG_SEES: '1' }
    const expected = await logOf((log) =>
      jestRunWith(log, 'jest.babel.config.json', ['--detectOpenHandles'], env),
    )
    assert.equal(expected.code, 0, expected.stderr)
    assert.match(expected.log, /\[test\] sees: set by the setup/, 'real Jest leaks it in band')
    const ran = await logOf(async (log) => {
      const ended = await spawnCli(
        ['jest', '-c', 'jest.babel.config.json', '--detectOpenHandles', '--no-cache', '--ci'],
        {
          cwd: FIXTURE,
          env: { GLOBAL_SETUP_LOG: log, ...env },
        },
      )
      return { code: ended.code, stderr: ended.stderr }
    })
    assert.equal(ran.code, 0, ran.stderr)
    assert.equal(ran.log, expected.log)
  })

  for (const name of ['babel', 'ts-jest']) {
    it(`${name}: the setup and the teardown run around the file, called as real Jest calls them`, async () => {
      const config = `jest.${name}.config.json`
      const expected = await jestRun(config)
      assert.equal(expected.code, 0, expected.stderr)
      assert.equal(expected.log, '[setup] global=same\n[test]\n[teardown]\n')
      const ran = await provinoRun(config)
      assert.equal(ran.code, 0, ran.stderr)
      assert.equal(ran.log, expected.log)
    })
  }
})
