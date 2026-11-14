// T9.9 (B23d, A3, D114): `--debug` prints `{ configs, globalConfig, version }` as JSON before the run,
// on stdout (stderr under `--json` or `--useStderr`), as jest-core's `logDebugMessages` does. Held to a
// live Jest 30.5.2 on the same tree, byte for byte but the seed (drawn on each run), and to the
// recorded `cli/debug` for the set of keys of the global config and of the project config.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { JEST, noColorEnv } from './live-jest.ts'
import { FIXTURES, loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** Under the harness package, where Jest is installed, so the project's own Jest is found as in a real project. */
const PARENT = join(FIXTURES, '..', '.record')

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

function jestOn(
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

/** The seed is drawn on each run, by Jest and by Provino. */
const withoutSeed = (text: string): string => text.replace(/"seed": -?\d+/, '"seed": 0')

/** The key paths of a parsed JSON value, one level of arrays ignored. */
function keysOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.keys(value).flatMap((key) =>
    keysOf((value as Record<string, unknown>)[key], `${prefix}.${key}`),
  )
}

async function project(): Promise<string> {
  await mkdir(PARENT, { recursive: true })
  const root = await realpath(await mkdtemp(join(PARENT, 'debug-')))
  made.push(root)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(
    join(root, 'jest.config.json'),
    '{"testMatch":["<rootDir>/*.test.js"],"displayName":"dbg","moduleFileExtensions":["js","json"]}\n',
  )
  await writeFile(join(root, 'a.test.js'), "test('a', () => {})\n")
  return root
}

describe('provino jest --debug against Jest 30.5.2', () => {
  it('prints the config JSON on stdout, as a live Jest does', async () => {
    const root = await project()
    const args = ['--debug', '--listTests']
    const jest = await jestOn(root, args)
    const provino = await spawnCli(['jest', ...args], { cwd: root })
    assert.equal(provino.code, jest.code, provino.stderr)
    assert.equal(withoutSeed(provino.stdout), withoutSeed(jest.stdout))
    assert.match(provino.stdout, /^\{\n {2}"configs": \[/)
    assert.match(provino.stdout, /"version": "30\.5\.2"\n\}\n/)
  })

  it('goes to stderr with --useStderr and --json, leaving stdout to the results', async () => {
    const root = await project()
    for (const flag of ['--useStderr', '--json']) {
      const args = ['--debug', flag, '--outputFile=out.json']
      const jest = await jestOn(root, args)
      const provino = await spawnCli(['jest', ...args], { cwd: root })
      assert.equal(provino.code, jest.code, provino.stderr)
      const debug = (text: string): string => withoutSeed(text.slice(0, text.indexOf('\n}\n') + 3))
      assert.equal(debug(provino.stderr), debug(jest.stderr), flag)
      assert.equal(provino.stdout, jest.stdout, flag)
    }
  })

  it('is printed before --showConfig prints it again, as Jest does', async () => {
    const root = await project()
    const args = ['--debug', '--showConfig']
    const jest = await jestOn(root, args)
    const provino = await spawnCli(['jest', ...args], { cwd: root })
    assert.equal(provino.code, jest.code, provino.stderr)
    assert.equal(
      withoutSeed(provino.stdout).split('"version": "30.5.2"').length,
      3,
      'two copies on stdout',
    )
  })

  it('cli/debug: the keys of the global config and of the project config are the recorded ones', async () => {
    const fixture = await loadFixture('cli/debug')
    const project = await materialize(fixture, { parent: PARENT })
    try {
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          '--json',
          `--outputFile=${join(project.root, 'out.json')}`,
          '--debug',
        ],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const jsonOf = (
        text: string,
      ): { configs: unknown[]; globalConfig: unknown; version: string } =>
        JSON.parse(
          text.slice(text.indexOf('{'), text.indexOf('\n}\n') + 2).replaceAll('<masked>', '0'),
        )
      const ours = jsonOf(ended.stderr)
      const recorded = jsonOf(fixture.golden.observed?.stderr ?? '')
      assert.equal(ours.version, recorded.version)
      assert.deepEqual(keysOf(ours.globalConfig).sort(), keysOf(recorded.globalConfig).sort())
      // The recorder's project config adds a transform, setup files and its own cache directory: the
      // keys are the same, the values of those are not.
      const projectKeys = (value: unknown): string[] =>
        Object.keys((value as Record<string, unknown>[])[0] ?? {}).sort()
      assert.deepEqual(projectKeys(ours.configs), projectKeys(recorded.configs))
      assert.equal(
        (recorded.configs[0] as { cwd?: string } | undefined)?.cwd,
        '<root>',
        'the recording is of the project under <root>',
      )
    } finally {
      await project.dispose()
    }
  })
})
