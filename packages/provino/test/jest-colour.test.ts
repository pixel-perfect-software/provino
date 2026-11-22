// The colour a `provino jest` run decides against supports-color 7.2.0, which Jest's chalk 4
// resolves: a `FORCE_COLOR` in the environment overrides `--colors` and `--no-color`, and
// `NO_COLOR` is never read (index.js L21-L29, L45). Each answer is the child's own, from that
// package under that command line and environment.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Loaded by URL: the type-test project includes `test/` but not `src/`.
const { jestColourRequest } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  jestColourRequest: (
    env: Readonly<Record<string, string | undefined>>,
    flag: boolean | undefined,
  ) => boolean | undefined
}
const { outputFor } = (await import(
  new URL('../src/internal/reporters.ts', import.meta.url).href
)) as {
  outputFor: (context: {
    env: Record<string, string | undefined>
    stderr: object
    ci: boolean
    colour?: boolean | undefined
  }) => { colour: boolean }
}

// jest-message-util is the Jest add-on's dependency since B27f (D187), so it is reached through it.
const here = createRequire(import.meta.url)
const dialect = createRequire(here.resolve('@provino/dialect-jest/node'))
const fromMessageUtil = createRequire(dialect.resolve('jest-message-util/package.json'))
const fromChalk = createRequire(fromMessageUtil.resolve('chalk/package.json'))
const SUPPORTS_COLOR = fromChalk.resolve('supports-color')

/** What supports-color answers for a terminal stdout, given the command line and environment. */
async function theirs(flags: readonly string[], env: Record<string, string>): Promise<boolean> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '-e',
      // The flags are read from `process.argv` when the package loads.
      `process.argv.push(...${JSON.stringify(flags)}); console.log(JSON.stringify(Boolean(require(${JSON.stringify(SUPPORTS_COLOR)}).supportsColor({ isTTY: true }))))`,
    ],
    { env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color', ...env }, encoding: 'utf8' },
  )
  return stdout.trim() === 'true'
}

/** What `provino jest` decides for the same command line and environment. */
function ours(flag: boolean | undefined, env: Record<string, string>): boolean {
  const environment = { TERM: 'xterm-256color', ...env }
  return outputFor({
    env: environment,
    stderr: { isTTY: true },
    ci: false,
    colour: jestColourRequest(environment, flag),
  }).colour
}

describe('provino jest colour follows supports-color, as Jest does', async () => {
  const flags: readonly [string, readonly string[], boolean | undefined][] = [
    ['--colors', ['--colors'], true],
    ['--no-color', ['--no-color'], false],
    ['no flag', [], undefined],
  ]
  const envs: readonly [string, Record<string, string>][] = [
    ['FORCE_COLOR=0', { FORCE_COLOR: '0' }],
    ['FORCE_COLOR=1', { FORCE_COLOR: '1' }],
    ['FORCE_COLOR unset', {}],
    ['NO_COLOR=1', { NO_COLOR: '1' }],
  ]
  // What supports-color says for each cell, asked of all the children at once.
  const cells = await Promise.all(
    flags.flatMap(([flagName, argv, flag]) =>
      envs.map(async ([envName, env]) => ({
        flagName,
        flag,
        envName,
        env,
        answer: await theirs(argv, env),
      })),
    ),
  )
  for (const { flagName, flag, envName, env, answer } of cells) {
    // Declared divergence: on a terminal with no flag, `NO_COLOR` turns Provino's colour off
    // (reporters.test.ts holds that) where Jest's chalk, which never reads it, colours.
    const declared = flag === undefined && 'NO_COLOR' in env
    it(`${flagName} with ${envName}${declared ? ' (declared: NO_COLOR is read)' : ''}`, () => {
      if (declared) {
        assert.equal(ours(flag, env), false)
        assert.equal(answer, true)
      } else {
        assert.equal(ours(flag, env), answer)
      }
    })
  }
})
