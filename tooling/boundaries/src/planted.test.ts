// Plants each kind of boundary violation in a scratch copy of the workspace layout and runs the
// real tools on it, so a rule that stops firing (a Biome or dependency-cruiser upgrade, a
// manifest edit) fails here and not silently in CI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { BIOME_BIN, DEPCRUISE_BIN, ROOT } from './paths.ts'
import { scratchDir, writeFiles } from './test-support.ts'

interface Result {
  readonly code: number | null
  readonly output: string
}

function run(entry: string, args: readonly string[], cwd: string): Promise<Result> {
  const { FORCE_COLOR: _force, ...env } = process.env
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      // FORCE_COLOR would win over NO_COLOR for dependency-cruiser and colour the output.
      env: { ...env, NO_COLOR: '1' },
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

/** A scratch dir with the repo's Biome config and plugins, plus `files`. */
async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await scratchDir('planted')
  await cp(join(ROOT, 'biome.json'), join(dir, 'biome.json'))
  for (const sub of ['tooling/boundaries/generated', 'tooling/boundaries/grit']) {
    await cp(join(ROOT, sub), join(dir, sub), { recursive: true })
  }
  await writeFiles(dir, files)
  return dir
}

/**
 * Adds real workspace packages to a scratch dir, linked into node_modules the way pnpm does,
 * so imports resolve through `exports` and `provino-source` to the package's src/.
 */
async function linkPackages(dir: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const pkgDir = join(dir, 'packages', name)
    await mkdir(join(pkgDir, 'src'), { recursive: true })
    const exports = { '.': { 'provino-source': './src/index.ts', types: './dist/index.d.ts' } }
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@provino/${name}`, type: 'module', exports }),
    )
    await writeFile(join(pkgDir, 'src/index.ts'), 'export const value = 1\n')
    await mkdir(join(dir, 'node_modules/@provino'), { recursive: true })
    await symlink(pkgDir, join(dir, 'node_modules/@provino', name), 'dir')
  }
}

/**
 * A package in the scratch dir's node_modules, flat (`node_modules/<name>`) or the way pnpm lays it
 * out (a real copy under `node_modules/.pnpm/<name>@1.0.0/node_modules` and a symlink to it).
 */
async function installModule(dir: string, name: string, layout: 'flat' | 'pnpm'): Promise<void> {
  const real =
    layout === 'flat'
      ? join(dir, 'node_modules', name)
      : join(dir, 'node_modules/.pnpm', `${name.replace('/', '+')}@1.0.0`, 'node_modules', name)
  await mkdir(real, { recursive: true })
  await writeFile(
    join(real, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
  )
  await writeFile(join(real, 'index.js'), 'module.exports = {}\n')
  if (layout === 'pnpm') {
    await mkdir(dirname(join(dir, 'node_modules', name)), { recursive: true })
    await symlink(real, join(dir, 'node_modules', name), 'dir')
  }
}

const biome = (dir: string, path: string): Promise<Result> =>
  run(BIOME_BIN, ['lint', '--vcs-enabled=false', path], dir)
const depcruise = (dir: string): Promise<Result> =>
  run(DEPCRUISE_BIN, ['--config', join(ROOT, '.dependency-cruiser.json'), 'packages'], dir)
const count = (output: string, rule: string): number =>
  output.match(new RegExp(`× ${rule}`, 'g'))?.length ?? 0

// Every case has its own scratch dir, so the cases run at once (about 3x faster).
describe('Biome GritQL plugins', { concurrency: true }, () => {
  test('slice-discipline: `import type { MockPolicy }` in @provino/core fails, naming the rule', async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: "import type { MockPolicy } from '@provino/types'\nexport type P = MockPolicy\n",
    })
    const { code, output } = await biome(dir, path)
    assert.notEqual(code, 0, output)
    assert.match(
      output,
      /slice-discipline: this package may use only its own policy slice type \(CorePolicy\)/,
    )
  })

  test('slice-discipline catches aliases, re-exports, qualified types and the whole Policy', async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: [
        "import type { TimersPolicy as T } from '@provino/types'",
        "export type { SnapshotPolicy } from '@provino/types'",
        "export type Q = import('@provino/types').ExpectPolicy",
        "export type W = import('@provino/types').Policy",
        'export type U = T',
        '',
      ].join('\n'),
    })
    assert.equal(count((await biome(dir, path)).output, 'slice-discipline'), 4)
  })

  test('slice-discipline catches the values that hand out the whole policy', async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: [
        "import { neutralPolicy, resolvePolicy } from '@provino/policy'",
        'export const t = neutralPolicy.timers',
        'export const m = resolvePolicy().mock',
        '',
      ].join('\n'),
    })
    // Two imports and two uses.
    assert.equal(count((await biome(dir, path)).output, 'slice-discipline'), 4)
  })

  test("slice-discipline allows a package's own slice, exempt packages, tests and test support", async () => {
    const dir = await workspace({
      'packages/core/src/internal/test-support.ts':
        "import { neutralPolicy } from '@provino/policy'\nexport const c = neutralPolicy.core\n",
      'packages/core/src/ok.ts':
        "import type { CorePolicy } from '@provino/types'\nexport type P = CorePolicy\n",
      'packages/core/src/ok.test.ts':
        "import { resolvePolicy } from '@provino/policy'\nexport const c = resolvePolicy().core\n",
      'packages/core/test/ok.test-d.ts':
        "import type { Policy } from '@provino/types'\nexport type P = Policy\n",
      'packages/dialect-jest/src/ok.ts':
        "import type { MockPolicy, Policy } from '@provino/types'\nexport type P = [MockPolicy, Policy]\n",
    })
    assert.doesNotMatch((await biome(dir, 'packages')).output, /slice-discipline/)
  })

  test('neutral-no-dialect-name: comparisons, lookups and keys naming a runner in @provino/core fail', async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: [
        'declare const n: string',
        "export const a = n === 'jest'",
        'export const b = "vitest" != n',
        'export const c = n === `jest`',
        "export const d = ['jest', 'vitest'].includes(n)",
        "export const e = Object.is(n, 'jest')",
        'export const f = ({ jest: 1 } as Record<string, number>)[n]',
        "export function g(): number { switch (n) { case 'vitest': return 1 } return 0 }",
        '',
      ].join('\n'),
    })
    const { code, output } = await biome(dir, path)
    assert.notEqual(code, 0, output)
    assert.equal(count(output, 'neutral-no-dialect-name'), 8)
  })

  test('neutral-no-dialect-name spares dialects, tests and other strings', async () => {
    const dir = await workspace({
      'packages/dialect-jest/src/ok.ts': "export const a = (n: string): boolean => n === 'jest'\n",
      'packages/core/src/ok.ts':
        "export const b = (n: string): boolean => n === 'jester' || n === 'Jest'\n",
      'packages/core/src/ok.test.ts': "export const c = (n: string): boolean => n === 'vitest'\n",
    })
    assert.doesNotMatch((await biome(dir, 'packages')).output, /neutral-no-dialect-name/)
  })
})

describe('dependency-cruiser rules', { concurrency: true }, () => {
  test("`import '@provino/dialect-jest'` in @provino/core fails neutral-no-dialect and boundary-core", async () => {
    const dir = await workspace({
      'packages/core/src/planted.ts': "import '@provino/dialect-jest'\n",
    })
    const { code, output } = await depcruise(dir)
    assert.notEqual(code, 0, output)
    assert.match(
      output,
      /error neutral-no-dialect: packages\/core\/src\/planted\.ts → @provino\/dialect-jest/,
    )
    assert.match(
      output,
      /error boundary-core: packages\/core\/src\/planted\.ts → @provino\/dialect-jest/,
    )
  })

  test('the same rules fire when the dialect resolves through node_modules to its source', async () => {
    const dir = await workspace({
      'packages/core/src/planted.ts': "import '@provino/dialect-jest'\n",
    })
    await linkPackages(dir, ['dialect-jest'])
    const { output } = await depcruise(dir)
    const edge = 'packages/core/src/planted\\.ts → packages/dialect-jest/src/index\\.ts'
    assert.match(output, new RegExp(`error neutral-no-dialect: ${edge}`))
    assert.match(output, new RegExp(`error boundary-core: ${edge}`))
    assert.doesNotMatch(output, /not-to-unresolvable/)
  })

  test('an upward import fails the boundary rule, resolved or not', async () => {
    const dir = await workspace({ 'packages/types/src/planted.ts': "import '@provino/policy'\n" })
    assert.match(
      (await depcruise(dir)).output,
      /error boundary-types: packages\/types\/src\/planted\.ts → @provino\/policy/,
    )
    await linkPackages(dir, ['policy'])
    assert.match(
      (await depcruise(dir)).output,
      /error boundary-types: .* → packages\/policy\/src\/index\.ts/,
    )
  })

  test("a deep import past a package's exports fails not-to-unresolvable", async () => {
    const dir = await workspace({
      'packages/core/src/planted.ts': "import '@provino/types/src/index.ts'\n",
    })
    await linkPackages(dir, ['types'])
    assert.match(
      (await depcruise(dir)).output,
      /error not-to-unresolvable: .* → @provino\/types\/src\/index\.ts/,
    )
  })

  test("the orchestrator's coordinator code can't reach into its worker entry, and back", async () => {
    const dir = await workspace({
      'packages/orchestrator/src/run.ts': "import './worker/entry.ts'\n",
      'packages/orchestrator/src/worker/entry.ts': "import '../shared.ts'\n",
      'packages/orchestrator/src/shared.ts': 'export {}\n',
    })
    const { output } = await depcruise(dir)
    assert.match(
      output,
      /error boundary-orchestrator: packages\/orchestrator\/src\/run\.ts → packages\/orchestrator\/src\/worker\/entry\.ts/,
    )
    assert.match(
      output,
      /error boundary-orchestrator-worker: packages\/orchestrator\/src\/worker\/entry\.ts → packages\/orchestrator\/src\/shared\.ts/,
    )
  })

  test("a package's tests may import its subpath entries", async () => {
    const dir = await workspace({
      'packages/snapshot/test/runtime.test-d.ts':
        "import '../src/runtime/index.ts'\nimport '../src/node/index.ts'\n",
      'packages/snapshot/src/runtime/index.ts': 'export {}\n',
      'packages/snapshot/src/node/index.ts': 'export {}\n',
    })
    const { code, output } = await depcruise(dir)
    assert.equal(code, 0, output)
  })

  test('production code importing a test-support module fails test-support-only-in-tests', async () => {
    const dir = await workspace({
      'packages/core/src/internal/test-support.ts': 'export const help = 1\n',
      'packages/core/src/planted.ts':
        "import { help } from './internal/test-support.ts'\nexport const x = help\n",
      'packages/core/src/ok.test.ts':
        "import { help } from './internal/test-support.ts'\nexport const y = help\n",
    })
    const { output } = await depcruise(dir)
    assert.match(
      output,
      /error test-support-only-in-tests: packages\/core\/src\/planted\.ts → packages\/core\/src\/internal\/test-support\.ts/,
    )
    // The test importing the same module is fine.
    assert.doesNotMatch(output, /ok\.test\.ts/)
  })

  test('a relative import into another package fails public-entry-only', async () => {
    const dir = await workspace({
      'packages/core/src/planted.ts': "import '../../policy/src/index.ts'\n",
      'packages/policy/src/index.ts': 'export {}\n',
    })
    assert.match(
      (await depcruise(dir)).output,
      /error public-entry-only: packages\/core\/src\/planted\.ts → packages\/policy\/src\/index\.ts/,
    )
  })

  test('a runtime cycle fails no-circular; type-only cycles of either kind pass', async () => {
    const runtime = await workspace({
      'packages/core/src/a.ts': "import { b } from './b.ts'\nexport const a = (): number => b()\n",
      'packages/core/src/b.ts': "import { a } from './a.ts'\nexport const b = (): number => a()\n",
    })
    assert.match((await depcruise(runtime)).output, /error no-circular/)
    const typeOnly = await workspace({
      'packages/core/src/a.ts': "import type { B } from './b.ts'\nexport interface A { b?: B }\n",
      'packages/core/src/b.ts':
        "export type Bb = import('./c.ts').C\nimport type { A } from './a.ts'\nexport interface B { a?: A }\n",
      'packages/core/src/c.ts': "export type C = import('./b.ts').Bb\n",
    })
    const { code, output } = await depcruise(typeOnly)
    assert.equal(code, 0, output)
  })

  test('T7.12: a runtime import of a banned package in @provino/expect or @provino/snapshot fails banned-packages', async () => {
    for (const layout of ['flat', 'pnpm'] as const) {
      const dir = await workspace({
        'packages/expect/src/planted.ts': [
          "import 'jest-snapshot'",
          "import { equals } from 'expect'",
          "import '@vitest/expect'",
          "import '@vitest/snapshot'",
          "import '@babel/core'",
          'export const x = equals',
          '',
        ].join('\n'),
        'packages/snapshot/src/runtime/planted.ts': "import 'jest-snapshot'\n",
        'packages/snapshot/src/node/planted.ts': "export * from '@babel/parser'\n",
      })
      for (const name of [
        'jest-snapshot',
        'expect',
        '@vitest/expect',
        '@vitest/snapshot',
        '@babel/core',
        '@babel/parser',
      ]) {
        await installModule(dir, name, layout)
      }
      const { code, output } = await depcruise(dir)
      assert.notEqual(code, 0, output)
      for (const name of [
        'jest-snapshot',
        'expect',
        '@vitest/expect',
        '@vitest/snapshot',
        '@babel/core',
      ]) {
        assert.match(
          output,
          new RegExp(
            `error banned-packages-expect: packages/expect/src/planted\\.ts → .*${name.replace('/', '\\/')}`,
          ),
          `${layout}: ${name}\n${output}`,
        )
      }
      assert.match(
        output,
        /error banned-packages-snapshot-runtime: packages\/snapshot\/src\/runtime\/planted\.ts/,
      )
      assert.match(
        output,
        /error banned-packages-snapshot-node: packages\/snapshot\/src\/node\/planted\.ts/,
      )
    }
  })

  test('the ban list spares tests, type imports, allowed packages and other packages', async () => {
    for (const layout of ['flat', 'pnpm'] as const) {
      const dir = await workspace({
        // A test may run the real engines as oracles.
        'packages/expect/src/interop.test.ts':
          "import 'expect'\nimport '@vitest/expect'\nimport 'jest-snapshot'\n",
        'packages/expect/src/ok.ts': [
          "import type { Matchers } from 'expect'",
          "import { equals } from '@jest/expect-utils'",
          'export type M = Matchers',
          'export const e = equals',
          '',
        ].join('\n'),
        // A package without a ban list may import them.
        'packages/dialect-jest/src/ok.ts': "import 'expect'\n",
      })
      for (const name of ['jest-snapshot', 'expect', '@vitest/expect', '@jest/expect-utils']) {
        await installModule(dir, name, layout)
      }
      const { output } = await depcruise(dir)
      assert.doesNotMatch(output, /banned-packages/, `${layout}: ${output}`)
    }
  })

  test('allowed imports pass', async () => {
    const dir = await workspace({
      'packages/core/src/ok.ts':
        "import './local.ts'\nimport 'node:test'\nimport '@provino/policy'\n",
      'packages/core/src/local.ts': 'export {}\n',
    })
    await linkPackages(dir, ['policy'])
    const { code, output } = await depcruise(dir)
    assert.equal(code, 0, output)
  })
})
