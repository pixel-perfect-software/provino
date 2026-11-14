// DV88: a frame named after the name its source map holds at its own position (`ModulePolicy.
// stackFrameNames`), the way Jest's source-map support names `at Object.toBe (x.test.ts:6:15)`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { SerializedLoaderConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'
import { installSourceMappedStacks } from './stacks.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const CONFIG: SerializedLoaderConfig = {
  hoist: null,
  moduleScope: [],
  extensions: ['.ts', '.js', '.cjs', '.json'],
  conditions: ['node'],
  tsconfig: false,
  mappers: [],
  typescript: 'oxc',
}

const SOURCE = [
  'const checks = {',
  '  matcher(): never {',
  "    throw new Error('named')",
  '  },',
  '}',
  '',
  'export function run(): string | undefined {',
  '  try {',
  '    const received: number = 1',
  '    void received',
  '    checks.matcher()',
  '  } catch (error) {',
  '    return (error as Error).stack',
  '  }',
  '  return undefined',
  '}',
  '',
].join('\n')

async function framesIn(frameNames: 'mapped-name' | 'engine'): Promise<string[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-names-')))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  const file = join(root, 'named.ts')
  writeFileSync(file, SOURCE)
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const uninstall = installSourceMappedStacks(loader, { frameNames })
  try {
    const { run } = await loader
      .createFileRegistry(file, { tier: 'registry' })
      .import<{ run(): string | undefined }>(file)
    return (run() ?? '').split('\n').filter((line) => line.includes(`${file}:`))
  } finally {
    uninstall()
  }
}

test('engine keeps the name V8 gave a frame', async () => {
  const frames = await framesIn('engine')
  assert.ok(frames.length >= 2, frames.join('\n'))
  assert.ok(
    frames.some((line) => / run \(.*named\.ts:11:12\)/.test(line)),
    frames.join('\n'),
  )
})

test('mapped-name names a frame after the identifier its map holds at that position', async () => {
  const engine = await framesIn('engine')
  const mapped = await framesIn('mapped-name')
  assert.equal(mapped.length, engine.length)
  // The call `checks.matcher()` on line 11 is named after what is called there.
  assert.ok(
    mapped.some((line) => /at (?:\S+\.)?matcher \(.*named\.ts:11:12\)/.test(line)),
    mapped.join('\n'),
  )
})
