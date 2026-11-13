// A package's `build` runs the shared tsdown config in `tooling/packaging`, so a change to that
// config must change the build's Turborepo hash, or a stale `dist/` is replayed from the cache.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ROOT } from './workspace.ts'

const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
  readonly globalDependencies?: readonly string[]
  readonly tasks: Readonly<Record<string, { readonly inputs?: readonly string[] }>>
}
const inputs = turbo.tasks.build?.inputs ?? []

/** The non-test files of the packaging package that a build reads, repo-relative. */
function buildFiles(): readonly string[] {
  const own = ['package.json', 'tsdown.config.ts', 'tsdown.umbrella.config.ts']
  const sources = readdirSync(join(ROOT, 'tooling/packaging/src'), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => `src/${file}`)
  return [...own, ...sources].map((file) => `tooling/packaging/${file}`)
}

/** Whether a `$TURBO_ROOT$` input glob (`dir/**`, or a file) covers a repo-relative path. */
function covers(glob: string, path: string): boolean {
  const pattern = glob.replace('$TURBO_ROOT$/', '')
  return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path
}

describe('the build task hashes the packaging config (turbo.json)', () => {
  test('every file a build reads from tooling/packaging is an input of `build`', () => {
    const rooted = inputs.filter(
      (input) => input.startsWith('$TURBO_ROOT$/') && !input.startsWith('!'),
    )
    const global = turbo.globalDependencies ?? []
    for (const file of buildFiles()) {
      assert.ok(
        rooted.some((input) => covers(input, file)) || global.includes(file),
        `${file} is not an input of the build task, so a change to it replays a stale dist/`,
      )
    }
  })

  test('its tests are not inputs: a test edit does not rebuild every package', () => {
    assert.ok(inputs.includes('!$TURBO_ROOT$/tooling/packaging/src/**/*.test.ts'))
  })
})
