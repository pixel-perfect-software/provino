// Plants each kind of boundary violation in a scratch copy of the workspace layout and runs the
// real tools on it, so a rule that stops firing (a Biome or dependency-cruiser upgrade, a
// manifest edit) fails here and not silently in CI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = (name: string): string => join(root, 'node_modules/.bin', name)
const scratch: string[] = []
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))))

interface Result {
  readonly code: number | null
  readonly output: string
}

function run(command: string, args: readonly string[], cwd: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

/** A scratch dir with the repo's Biome config and plugins, plus `files`. */
async function workspace(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-planted-'))
  scratch.push(dir)
  await cp(join(root, 'biome.json'), join(dir, 'biome.json'))
  await cp(join(root, 'tooling/boundaries/generated'), join(dir, 'tooling/boundaries/generated'), {
    recursive: true,
  })
  await cp(join(root, 'tooling/boundaries/grit'), join(dir, 'tooling/boundaries/grit'), {
    recursive: true,
  })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const biome = (dir: string, path: string): Promise<Result> =>
  run(bin('biome'), ['lint', '--vcs-enabled=false', path], dir)
const depcruise = (dir: string): Promise<Result> =>
  run(bin('depcruise'), ['--config', join(root, '.dependency-cruiser.json'), 'packages'], dir)

describe('Biome GritQL plugins', () => {
  test('slice-discipline: `import type { MockPolicy }` in @provino/core fails, naming the rule', async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: "import type { MockPolicy } from '@provino/types'\nexport type P = MockPolicy\n",
    })
    const { code, output } = await biome(dir, path)
    assert.notEqual(code, 0, output)
    assert.match(
      output,
      /slice-discipline: this package may import only its own policy slice type \(CorePolicy\)/,
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
    const { output } = await biome(dir, path)
    assert.equal(output.match(/× slice-discipline/g)?.length, 4, output)
  })

  test("slice-discipline allows a package's own slice, and exempt packages import any", async () => {
    const dir = await workspace({
      'packages/core/src/ok.ts':
        "import type { CorePolicy } from '@provino/types'\nexport type P = CorePolicy\n",
      'packages/dialect-jest/src/ok.ts':
        "import type { MockPolicy, Policy } from '@provino/types'\nexport type P = [MockPolicy, Policy]\n",
    })
    const { output } = await biome(dir, 'packages')
    assert.doesNotMatch(output, /slice-discipline/)
  })

  test("neutral-no-dialect-compare: `=== 'jest'` or `case 'vitest':` in @provino/core fails, naming the rule", async () => {
    const path = 'packages/core/src/planted.ts'
    const dir = await workspace({
      [path]: [
        "export const a = (n: string): boolean => n === 'jest'",
        'export const b = (n: string): boolean => "vitest" != n',
        "export function c(n: string): number { switch (n) { case 'vitest': return 1 } return 0 }",
        '',
      ].join('\n'),
    })
    const { code, output } = await biome(dir, path)
    assert.notEqual(code, 0, output)
    assert.equal(output.match(/× neutral-no-dialect-compare/g)?.length, 3, output)
  })

  test('neutral-no-dialect-compare spares dialects and other strings', async () => {
    const dir = await workspace({
      'packages/dialect-jest/src/ok.ts': "export const a = (n: string): boolean => n === 'jest'\n",
      'packages/core/src/ok.ts': "export const b = (n: string): boolean => n === 'jester'\n",
    })
    const { output } = await biome(dir, 'packages')
    assert.doesNotMatch(output, /neutral-no-dialect-compare/)
  })
})

describe('dependency-cruiser rules', () => {
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

  test('an upward import fails the boundary rule', async () => {
    const dir = await workspace({ 'packages/types/src/planted.ts': "import '@provino/policy'\n" })
    const { output } = await depcruise(dir)
    assert.match(
      output,
      /error boundary-types: packages\/types\/src\/planted\.ts → @provino\/policy/,
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

  test('a relative import into another package fails public-entry-only', async () => {
    const dir = await workspace({
      'packages/core/src/planted.ts': "import '../../policy/src/index.ts'\n",
      'packages/policy/src/index.ts': 'export {}\n',
    })
    const { output } = await depcruise(dir)
    assert.match(
      output,
      /error public-entry-only: packages\/core\/src\/planted\.ts → packages\/policy\/src\/index\.ts/,
    )
  })

  test('a runtime cycle fails no-circular; a type-only cycle passes', async () => {
    const runtime = await workspace({
      'packages/core/src/a.ts': "import { b } from './b.ts'\nexport const a = (): number => b()\n",
      'packages/core/src/b.ts': "import { a } from './a.ts'\nexport const b = (): number => a()\n",
    })
    assert.match((await depcruise(runtime)).output, /error no-circular/)
    const typeOnly = await workspace({
      'packages/core/src/a.ts': "import type { B } from './b.ts'\nexport interface A { b?: B }\n",
      'packages/core/src/b.ts': "import type { A } from './a.ts'\nexport interface B { a?: A }\n",
    })
    const { code, output } = await depcruise(typeOnly)
    assert.equal(code, 0, output)
  })

  test('allowed imports pass', async () => {
    const dir = await workspace({
      'packages/core/src/ok.ts': "import './local.ts'\nimport 'node:test'\n",
      'packages/core/src/local.ts': 'export {}\n',
    })
    const { code, output } = await depcruise(dir)
    assert.equal(code, 0, output)
  })
})
