// Helpers shared by the tests. Not a test file: `node --test` runs only `*.test.ts`.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { type Manifest, parseManifest } from './manifest.ts'

const scratch: string[] = []
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))))

/**
 * A fresh directory under the OS temp dir holding `files` (path → content), removed after the
 * test file finishes.
 * @public
 */
export async function scratchDir(
  prefix: string,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `provino-${prefix}-`))
  scratch.push(dir)
  await writeFiles(dir, files)
  return dir
}

/**
 * Writes `files` (path → content) under `dir`, creating directories as needed.
 * @public
 */
export async function writeFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/**
 * What a child process printed and how it ended.
 * @public
 */
export interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Both streams, in the order the chunks arrived. */
  readonly output: string
}

/**
 * Runs a Node entry file in a child process (in `cwd` when given) and collects its output.
 * @public
 */
export function runNode(
  entry: string,
  args: readonly string[],
  cwd?: string | undefined,
): Promise<RunResult> {
  // FORCE_COLOR would win over NO_COLOR for dependency-cruiser and colour the output.
  const { FORCE_COLOR: _force, ...env } = process.env
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: { ...env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      output += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      output += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, output }))
  })
}

/**
 * Adds workspace packages to a scratch dir, linked into node_modules the way pnpm does, so imports
 * resolve through `exports` and `provino-source` to the package's src/. A name is the package's
 * own, scoped or not (`@provino/policy`, `provino`); its directory is the last part. `deps` names,
 * per package, the linked packages it depends on: a `workspace:*` dependency in its package.json
 * and an import of each in its source.
 * @public
 */
export async function linkPackages(
  dir: string,
  names: readonly string[],
  deps: Readonly<Record<string, readonly string[]>> = {},
): Promise<void> {
  for (const name of names) {
    const pkgDir = join(dir, 'packages', name.split('/').pop() ?? name)
    const uses = deps[name] ?? []
    const exports = {
      '.': {
        'provino-source': './src/index.ts',
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    }
    const dependencies = Object.fromEntries(uses.map((use) => [use, 'workspace:*']))
    await writeFiles(pkgDir, {
      'package.json': JSON.stringify({ name, type: 'module', exports, dependencies }),
      'src/index.ts': `${uses.map((use) => `import '${use}'\n`).join('')}export const value = 1\n`,
    })
    await mkdir(dirname(join(dir, 'node_modules', name)), { recursive: true })
    // A junction needs no privilege on Windows (a 'dir' symlink does) and is a plain link elsewhere.
    await symlink(pkgDir, join(dir, 'node_modules', name), 'junction')
  }
}

/**
 * A manifest of just `nodes`, with the given slices and no whole-policy names.
 * @public
 */
export function manifestOf(
  nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  slices: Readonly<Record<string, string>> = {},
  bannedPackageSets: Readonly<Record<string, readonly string[]>> = {},
): Manifest {
  return parseManifest({
    slices,
    wholePolicyTypes: [],
    wholePolicyValues: [],
    bannedPackageSets,
    nodes,
  })
}
