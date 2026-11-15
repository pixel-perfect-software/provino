// The colour a `provino jest` run decides against supports-color 7.2.0, which Jest's chalk 4
// resolves: a `FORCE_COLOR` in the environment overrides `--colors` and `--no-color`, and
// `NO_COLOR` is never read (index.js L21-L29, L45). Each answer is the child's own, from that
// package under that command line and environment.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { jestColourRequest } from '../src/internal/jest-command.ts'
import { outputFor } from '../src/internal/reporters.ts'

const here = createRequire(import.meta.url)
const fromMessageUtil = createRequire(here.resolve('jest-message-util/package.json'))
const fromChalk = createRequire(fromMessageUtil.resolve('chalk/package.json'))
const SUPPORTS_COLOR = fromChalk.resolve('supports-color')

/** What supports-color answers for a terminal stdout, given the command line and environment. */
function theirs(flags: readonly string[], env: Record<string, string>): boolean {
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      // The flags are read from `process.argv` when the package loads.
      `process.argv.push(...${JSON.stringify(flags)}); console.log(JSON.stringify(Boolean(require(${JSON.stringify(SUPPORTS_COLOR)}).supportsColor({ isTTY: true }))))`,
    ],
    { env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color', ...env }, encoding: 'utf8' },
  )
  return out.trim() === 'true'
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

describe('provino jest colour follows supports-color, as Jest does', () => {
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
  for (const [flagName, argv, flag] of flags) {
    for (const [envName, env] of envs) {
      // Declared divergence: on a terminal with no flag, `NO_COLOR` turns Provino's colour off
      // (reporters.test.ts holds that) where Jest's chalk, which never reads it, colours.
      const declared = flag === undefined && 'NO_COLOR' in env
      it(`${flagName} with ${envName}${declared ? ' (declared: NO_COLOR is read)' : ''}`, () => {
        if (declared) {
          assert.equal(ours(flag, env), false)
          assert.equal(theirs(argv, env), true)
        } else {
          assert.equal(ours(flag, env), theirs(argv, env))
        }
      })
    }
  }

  it('--colors with FORCE_COLOR=0 is plain, whatever the flag says', () => {
    assert.equal(ours(true, { FORCE_COLOR: '0' }), false)
  })
})
