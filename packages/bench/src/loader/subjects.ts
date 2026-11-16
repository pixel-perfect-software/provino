// What the loader benches that run a generated Jest project as child processes share
// (`ui-library`, `megamorphic`): who runs it, the command line each subject is started with, the
// tree writer, and the project's own `jest-environment-jsdom`.
import { mkdirSync, symlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRunnerPackage } from '@provino/harness'

/** Who runs: Jest, this tree's `provino jest`, or the baseline tree's. */
export type Subject = 'provino' | 'jest' | 'baseline'

/** Writes `files` (path relative to `root` -> text) under `root`. */
export async function writeTree(root: string, files: ReadonlyMap<string, string>): Promise<void> {
  const dirs = new Set<string>()
  for (const path of files.keys()) dirs.add(dirname(join(root, path)))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  await Promise.all([...files].map(([path, text]) => writeFile(join(root, path), text)))
}

/** Links the harness's `jest-environment-jsdom` into the project, as a component suite installs it. */
export function linkJsdomEnvironment(root: string): void {
  const harness = createRequire(
    fileURLToPath(new URL('../../../harness/package.json', import.meta.url)),
  )
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(
    dirname(harness.resolve('jest-environment-jsdom/package.json')),
    join(root, 'node_modules', 'jest-environment-jsdom'),
    'dir',
  )
}

/**
 * The arguments to `node` that run `subject` on the project's `jest.config.json` with `flags`:
 * Jest's bin, or `provino jest` from this tree's source or the `baseline` checkout's, after
 * `nodeFlags`.
 */
export function subjectArgs(
  subject: Subject,
  flags: readonly string[],
  baseline: string | undefined,
  nodeFlags: readonly string[] = [],
): string[] {
  if (subject === 'jest') {
    return [
      resolveRunnerPackage('jest', import.meta.url).bin,
      '--config',
      'jest.config.json',
      ...flags,
    ]
  }
  if (subject === 'baseline' && baseline === undefined) {
    throw new Error('the baseline subject needs a checkout')
  }
  const cli =
    subject === 'baseline' && baseline !== undefined
      ? join(baseline, 'packages', 'provino', 'src', 'cli.ts')
      : fileURLToPath(new URL('../../../provino/src/cli.ts', import.meta.url))
  return [
    ...nodeFlags,
    '--conditions=provino-source',
    cli,
    'jest',
    '--config',
    'jest.config.json',
    ...flags,
  ]
}

/** How a subject is named in the output. */
export function subjectLabel(subject: Subject): string {
  return subject === 'jest'
    ? `jest ${resolveRunnerPackage('jest', import.meta.url).version}`
    : subject === 'baseline'
      ? 'baseline'
      : 'provino jest'
}
