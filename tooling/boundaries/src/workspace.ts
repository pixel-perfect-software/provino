import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  type Manifest,
  type ManifestNode,
  type Problem,
  packageReach,
  problem,
} from './manifest.ts'
import { SKIPPED_DIRS } from './paths.ts'
import { compare, matches } from './text.ts'

/**
 * A workspace package as its files declare it.
 * @public
 */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/core`. */
  readonly dir: string
  readonly name: string
  /** Every package it depends on, of any dependency kind. */
  readonly deps: readonly string[]
  /** The package.json `exports` field, as written. */
  readonly exports: unknown
  /** The package.json `test` script, if any. */
  readonly testScript: string | undefined
  /** How many `*.test.ts` files sit under `src/`. */
  readonly unitTests: number
  readonly hasTsconfig: boolean
  readonly hasTypeTests: boolean
  /** Its source files, relative to `dir`, without build output or dependencies. */
  readonly files: readonly string[]
}

/**
 * The workspace: its root directories, packages, and the solution tsconfigs' references.
 * @public
 */
export interface Workspace {
  /** Directories from `pnpm-workspace.yaml` `packages:` (`packages/*` → `packages`). */
  readonly roots: readonly string[]
  readonly packages: readonly WorkspacePackage[]
  /** Packages whose package.json didn't parse, with the error. */
  readonly unreadable: readonly { readonly dir: string; readonly error: string }[]
  /** `tsconfig.json` references (the typecheck solution). */
  readonly sourceProjects: ReadonlySet<string>
  /** `tsconfig.type-tests.json` references (the type-test solution). */
  readonly typeTestProjects: ReadonlySet<string>
  readonly pnpmWorkspaceYaml: string
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const SKIP_DIRS: ReadonlySet<string> = new Set(SKIPPED_DIRS)

/**
 * Reads the workspace under `root`. Packages are sorted by directory.
 * @public
 */
export async function readWorkspace(root: string): Promise<Workspace> {
  const pnpmWorkspaceYaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const roots = workspaceRoots(pnpmWorkspaceYaml)
  const dirs = (
    await Promise.all(
      roots.map(async (base) =>
        (
          await readdir(join(root, base), { withFileTypes: true }).catch(() => [])
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${base}/${entry.name}`),
      ),
    )
  ).flat()
  const packages: WorkspacePackage[] = []
  const unreadable: { dir: string; error: string }[] = []
  for (const result of await Promise.all(dirs.map((dir) => readPackage(root, dir)))) {
    if (result === undefined) continue
    if ('error' in result) unreadable.push(result)
    else packages.push(result)
  }
  return {
    roots,
    packages: packages.sort((a, b) => compare(a.dir, b.dir)),
    unreadable,
    sourceProjects: await references(join(root, 'tsconfig.json')),
    typeTestProjects: await references(join(root, 'tsconfig.type-tests.json')),
    pnpmWorkspaceYaml,
  }
}

/** A package dir: its package, its parse error, or `undefined` when it has no package.json. */
async function readPackage(
  root: string,
  dir: string,
): Promise<WorkspacePackage | { dir: string; error: string } | undefined> {
  const text = await readFile(join(root, dir, 'package.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let json: Readonly<Record<string, unknown>>
  try {
    json = asRecord(JSON.parse(text))
  } catch (err) {
    return { dir, error: err instanceof Error ? err.message : String(err) }
  }
  const scripts = asRecord(json.scripts)
  const files = await listFiles(join(root, dir))
  const deps = DEP_FIELDS.flatMap((field) => Object.keys(asRecord(json[field])))
  return {
    dir,
    name: String(json.name),
    deps: [...new Set(deps)].sort(compare),
    exports: json.exports,
    testScript: typeof scripts.test === 'string' ? scripts.test : undefined,
    unitTests: files.filter((file) => file.startsWith('src/') && file.endsWith('.test.ts')).length,
    hasTsconfig: existsSync(join(root, dir, 'tsconfig.json')),
    hasTypeTests: existsSync(join(root, dir, 'test/tsconfig.json')),
    files,
  }
}

/**
 * The `packages:` globs of a pnpm-workspace.yaml, as directories. Only the `<dir>/*` form is
 * supported, so another form fails loudly instead of being skipped.
 * @public
 */
export function workspaceRoots(yaml: string): readonly string[] {
  const block = /^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(yaml)?.[1] ?? ''
  return [...block.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => {
    const glob = match[1] ?? ''
    if (!/^[\w.-]+\/\*$/.test(glob)) {
      throw new Error(`pnpm-workspace.yaml: only "<dir>/*" globs are supported, got "${glob}"`)
    }
    return glob.slice(0, -2)
  })
}

/**
 * Checks the workspace against the manifest and the repo's conventions: every package is listed
 * under its own name, depends only on what the manifest allows, resolves source through
 * `provino-source`, is in both solution tsconfigs, and has the tests its test script runs.
 * @public
 */
export function checkWorkspace(manifest: Manifest, workspace: Workspace): readonly Problem[] {
  const tops = manifest.nodes.filter((node) => node.parent === undefined)
  const outsideRoots = (node: ManifestNode): boolean =>
    node.dir !== null && !workspace.roots.some((base) => node.dir?.startsWith(`${base}/`))
  return [
    ...workspace.unreadable.map(({ dir, error }) =>
      problem('workspace-package-json', `${dir}/package.json doesn't parse: ${error}`),
    ),
    ...manifest.nodes
      .filter(outsideRoots)
      .map((node) =>
        problem('manifest-dir', `${node.name}: dir "${node.dir}" is outside the workspace roots`),
      ),
    ...workspace.packages.flatMap((pkg) => checkPackage(manifest, tops, workspace, pkg)),
    ...checkTs6Pin(workspace.pnpmWorkspaceYaml),
  ]
}

function checkPackage(
  manifest: Manifest,
  tops: readonly ManifestNode[],
  workspace: Workspace,
  pkg: WorkspacePackage,
): readonly Problem[] {
  const node = tops.find((top) => top.dir !== null && matches(top.dir, pkg.dir))
  if (node === undefined) {
    return [
      problem(
        'manifest-unknown-package',
        `${pkg.dir} (${pkg.name}) is not in tooling/boundaries/packages.json`,
      ),
    ]
  }
  const problems: Problem[] = []
  if (!matches(node.name, pkg.name)) {
    problems.push(
      problem(
        'manifest-name',
        `${pkg.dir} is named "${pkg.name}", but the manifest lists it as "${node.name}"`,
      ),
    )
  }
  problems.push(...checkDeps(manifest, tops, node, pkg), ...checkExports(pkg))
  problems.push(...checkTsconfigs(workspace, pkg))
  // `node --test` passes when its glob matches nothing, so an empty run would look green.
  if (pkg.testScript?.includes('node --test') && pkg.unitTests === 0) {
    problems.push(
      problem(
        'workspace-tests',
        `${pkg.name}'s test script runs node --test, but src/ has no *.test.ts`,
      ),
    )
  }
  return problems
}

/** package.json deps must be allowed by the package or one of its entries. */
function checkDeps(
  manifest: Manifest,
  tops: readonly ManifestNode[],
  node: ManifestNode,
  pkg: WorkspacePackage,
): readonly Problem[] {
  // An entry (`@provino/snapshot/node`) is allowed through its package (`@provino/snapshot`).
  const allowed = new Set(packageReach(manifest, node).map((dep) => dep.parent ?? dep.name))
  return pkg.deps
    .filter((dep) => {
      const target = tops.find((top) => matches(top.name, dep))
      return target !== undefined && target !== node && !allowed.has(target.name)
    })
    .map((dep) =>
      problem(
        'manifest-deps',
        `${pkg.name} depends on ${dep} in package.json, but the manifest doesn't allow it`,
      ),
    )
}

/** Without provino-source first, tools resolve the package to dist/, which isn't cruised. */
function checkExports(pkg: WorkspacePackage): readonly Problem[] {
  return Object.entries(asRecord(pkg.exports))
    .filter(([, target]) => Object.keys(asRecord(target))[0] !== 'provino-source')
    .map(([subpath]) =>
      problem(
        'workspace-exports',
        `${pkg.name}: exports["${subpath}"] must list "provino-source" first`,
      ),
    )
}

function checkTsconfigs(workspace: Workspace, pkg: WorkspacePackage): readonly Problem[] {
  const problems: Problem[] = []
  if (pkg.hasTsconfig && !workspace.sourceProjects.has(pkg.dir)) {
    problems.push(
      problem(
        'workspace-tsconfig',
        `${pkg.dir} is missing from tsconfig.json references, so \`pnpm typecheck\` skips it`,
      ),
    )
  }
  if (pkg.hasTypeTests && !workspace.typeTestProjects.has(`${pkg.dir}/test`)) {
    problems.push(
      problem(
        'workspace-tsconfig',
        `${pkg.dir}/test is missing from tsconfig.type-tests.json references, so \`pnpm test:types\` skips it`,
      ),
    )
  }
  return problems
}

/** The catalog and packageExtensions each name @typescript/typescript6's version. */
function checkTs6Pin(yaml: string): readonly Problem[] {
  const catalog = /^\s+"@typescript\/typescript6":\s*(\S+)\s*$/m.exec(yaml)?.[1]
  const extension = /typescript:\s*npm:@typescript\/typescript6@(\S+)/.exec(yaml)?.[1]
  if (catalog === extension) return []
  return [
    problem(
      'workspace-ts6-pin',
      `pnpm-workspace.yaml pins @typescript/typescript6 ${catalog} in the catalog but ${extension} in packageExtensions`,
    ),
  ]
}

/**
 * Placed manifest dirs that git ignores. Biome skips ignored files, so a lint there never runs.
 * @public
 */
export function ignoredDirs(root: string, manifest: Manifest): readonly Problem[] {
  const probes = manifest.nodes.flatMap((node) =>
    node.dir === null ? [] : [{ node, path: `${node.dir.replaceAll('*', 'x')}/src/index.ts` }],
  )
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: root,
    input: probes.map((probe) => probe.path).join('\n'),
    encoding: 'utf8',
  })
  const ignored = new Set(result.stdout.split('\n').filter((line) => line !== ''))
  return probes
    .filter((probe) => ignored.has(probe.path))
    .map(({ node }) =>
      problem(
        'workspace-ignored-dir',
        `${node.name}: git ignores ${node.dir}, so Biome never lints it (check .gitignore)`,
      ),
    )
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
/**
 * A comment that would silence the boundary lints: `biome-ignore` (or `-all`/`-start`) of all of
 * `lint`, or of the plugins. Only a line that starts as a comment counts, not the text in a string.
 */
const PLUGIN_SUPPRESSION =
  /^\s*(?:\/\/|\/\*+|\*)\s*biome-ignore(?:-all|-start)?\s+lint(?:\/plugin\S*)?(?=[\s:(]|$)/

/**
 * Source files that suppress the GritQL boundary lints with a `biome-ignore` comment.
 * @public
 */
export async function pluginSuppressions(
  root: string,
  workspace: Workspace,
): Promise<readonly Problem[]> {
  const scans = workspace.packages.flatMap((pkg) =>
    pkg.files
      .filter((file) => SOURCE_FILE.test(file))
      .map(async (file): Promise<readonly Problem[]> => {
        const lines = (await readFile(join(root, pkg.dir, file), 'utf8')).split('\n')
        const line = lines.findIndex((text) => PLUGIN_SUPPRESSION.test(text))
        if (line === -1) return []
        return [
          problem(
            'no-plugin-suppression',
            `${pkg.dir}/${file}:${line + 1} suppresses the boundary lints; fix the code or change the manifest`,
          ),
        ]
      }),
  )
  return (await Promise.all(scans)).flat()
}

async function references(path: string): Promise<ReadonlySet<string>> {
  const json = asRecord(JSON.parse(await readFile(path, 'utf8')))
  const refs = Array.isArray(json.references) ? json.references : []
  return new Set(refs.map((ref: unknown) => String(asRecord(ref).path)))
}

/** Files under `dir`, relative to it with `/` separators, skipping build output and dependencies. */
async function listFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep))
    .filter((parts) => !parts.some((part) => SKIP_DIRS.has(part)))
    .map((parts) => parts.join('/'))
    .sort(compare)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
